import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Project } from 'ts-morph';
import { extractIR } from '../src/index.js';
import { extractRoleSignals } from '../src/role-signal-extractor.js';

async function tmpProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-role-'));
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf-8');
  }
  return root;
}

function signalsFor(sourceText: string, filePath = 'src/fixture.tsx') {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('fixture.tsx', sourceText);
  return extractRoleSignals(sourceFile, filePath);
}

describe('extractRoleSignals', () => {
  it('extracts access and actor-type values from an identity role union', () => {
    expect(signalsFor(`interface IMentor { role?: 'mentor' | 'admin' }`)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'mentor', kind: 'actor_type', source: 'explicit' }),
        expect.objectContaining({ value: 'admin', kind: 'access', source: 'explicit' }),
      ]),
    );
  });

  it('extracts role enums from a Mongoose schema', () => {
    expect(signalsFor(`
      const mentorSchema = new mongoose.Schema<IMentor>({
        role: { type: String, enum: ['mentor', 'admin'], default: 'mentor' },
      });
    `)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'mentor', detector: 'mongoose-role-enum' }),
      ]),
    );
  });

  it('extracts nested mentor roles from a non-identity Mongoose schema', () => {
    expect(signalsFor(`
      const programSchema = new mongoose.Schema<IProgram>({
        mentors: [{
          _id: { type: Schema.Types.ObjectId, ref: 'Mentor' },
          role: { type: String, enum: ['owner', 'mentor'], default: 'mentor' },
        }],
      });
    `)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'owner', detector: 'mongoose-role-enum' }),
        expect.objectContaining({ value: 'mentor', detector: 'mongoose-role-enum' }),
      ]),
    );
  });

  it('rejects the 14 prompt and custom-field enum false positives', () => {
    const signals = signalsFor(`
      const PromptSchema = new mongoose.Schema<IPrompt>({
        type: {
          type: String,
          enum: [
            'BUSINESS_DIAGNOSIS',
            'MENTORING_SUMMARY',
            'MENTORING_QA_EXTRACT',
            'AI_CHAT_ANALYZE_SYSTEM',
            'AI_CHAT_ANALYZE_USER',
            'AI_CHAT_PHASE1_SYSTEM',
            'AI_CHAT_PHASE1_USER',
            'AI_CHAT_PHASE2_SYSTEM',
            'AI_CHAT_PHASE2_USER',
            'AI_CHAT_DRAFT_SYSTEM',
            'AI_CHAT_DRAFT_USER',
          ],
        },
      });
      const customFieldSchema = new mongoose.Schema({
        type: { type: String, enum: ['text', 'date', 'number'] },
      });
    `);

    expect(signals).toEqual([]);
  });

  it('extracts auth-subject role comparisons as middleware evidence', () => {
    expect(signalsFor(`
      if (session.user.role !== 'admin') throw new Error();
      if (token.role === 'owner') allow();
      if (req.user.userRole === 'manager') allow();
    `)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'admin', kind: 'access', source: 'middleware' }),
        expect.objectContaining({ value: 'owner', kind: 'access', source: 'middleware' }),
        expect.objectContaining({ value: 'manager', kind: 'access', source: 'middleware' }),
      ]),
    );
  });

  it('requires an auth-subject chain even in auth-related files', () => {
    expect(signalsFor(`if (role === 'admin') allow()`, 'src/middleware.ts')).toEqual([]);
    expect(signalsFor(`if (role === 'admin') allow()`, 'src\\middleware.ts')).toEqual([]);
    expect(signalsFor(`if (role === 'admin') allow()`, 'src/report.ts')).toEqual([]);
  });

  it('rejects chat message role comparisons inside session routes', () => {
    expect(signalsFor(`
      if (session.message.role === 'assistant') render();
      if (message.role === 'user') render();
      if (m.role === 'user') render();
      if (response.role === 'assistant') render();
    `, 'app/api/ai-chat/session/[id]/route.ts')).toEqual([]);
  });

  it('extracts conservative string enums and role constants', () => {
    expect(signalsFor(`
      enum UserRole { Admin = 'admin', Mentor = 'mentor' }
      const AUTH_ROLES = ['owner', 'manager'] as const;
      const MENTOR_ROLES = { MENTOR: 'mentor', ADMIN: 'admin' } as const;
      const ROLE_REVIEWER = 'reviewer' as const;
    `)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'admin', detector: 'auth-role-definition' }),
        expect.objectContaining({ value: 'mentor', detector: 'auth-role-definition' }),
        expect.objectContaining({ value: 'owner', detector: 'auth-role-definition' }),
        expect.objectContaining({ value: 'manager', detector: 'auth-role-definition' }),
        expect.objectContaining({ value: 'reviewer', detector: 'auth-role-definition' }),
      ]),
    );
  });

  it('uses role-map keys instead of localized display labels', () => {
    const signals = signalsFor(`
      const PROGRAM_ROLE = { owner: 'PO', mentor: '멘토' };
      const MENTOR_ROLE = { admin: '관리자', mentor: '멘토' };
    `);

    expect(signals.map((signal) => signal.value)).toEqual(
      expect.arrayContaining(['owner', 'mentor', 'admin']),
    );
    expect(signals).toHaveLength(4);
    expect(signals.map((signal) => signal.value)).not.toEqual(
      expect.arrayContaining(['PO', '멘토', '관리자']),
    );
  });

  it('rejects AI, DOM, and business enum or constant definitions', () => {
    expect(signalsFor(`
      enum PromptType { System = 'system_prompt', User = 'user_prompt' }
      enum ButtonRole { Button = 'button', Dialog = 'dialog' }
      const AI_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
      const ORDER_TYPES = ['purchase', 'refund'] as const;
      const ROLE_BUTTON = 'button' as const;
    `)).toEqual([]);
  });

  it('rejects AI message role unions', () => {
    expect(signalsFor(`type Message = { role: 'system' | 'user' | 'assistant' }`)).toEqual([]);
    expect(signalsFor(`type UserMessage = { role: 'system' | 'user' | 'assistant' }`)).toEqual([]);
  });

  it('rejects DOM and ARIA role attributes', () => {
    expect(signalsFor(`const x = <div role="button" />`)).toEqual([]);
  });

  it('does not treat role-like properties on non-identity declarations as roles', () => {
    expect(signalsFor(`type BuildConfig = { kind: 'customer' | 'seller' }`)).toEqual([]);
  });

  it('only reads direct role fields from identity declarations', () => {
    expect(signalsFor(`
      interface UserPreferences {
        kind: 'compact' | 'full';
        display: { role: 'primary' | 'secondary' };
      }
      interface IUser {
        display: { role: 'primary' | 'secondary' };
      }
    `)).toEqual([]);
  });

  it('reports every evidence location with a 1-based line', () => {
    const signals = signalsFor(`
interface IMentor {
  role?: 'mentor' | 'admin';
}
`);

    expect(signals).not.toHaveLength(0);
    expect(signals.every((signal) => signal.line !== undefined && signal.line >= 1)).toBe(true);
    expect(signals.map((signal) => signal.line)).toEqual([3, 3]);
  });
});

describe('extractIR role signal wiring', () => {
  it('scans handwritten declarations while excluding generated declarations', async () => {
    const root = await tmpProject({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'app/page.tsx': `export default function Page() { return null }`,
      'types/mentor.d.ts': `interface IMentor { role?: 'mentor' | 'admin' }`,
      'next-env.d.ts': `interface IUser { role?: 'next-env-role' }`,
      'generated/client.d.ts': `interface IUser { role?: 'generated-role' }`,
      'types/api.generated.d.ts': `interface IUser { role?: 'generated-suffix-role' }`,
    });

    const ir = await extractIR({ rootDir: root, includeImportGraph: false });

    expect(ir.files).toContain(join('types', 'mentor.d.ts'));
    expect(ir.files).not.toContain('next-env.d.ts');
    expect(ir.files).not.toContain(join('generated', 'client.d.ts'));
    expect(ir.files).not.toContain(join('types', 'api.generated.d.ts'));
    expect(ir.role_signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'mentor',
          kind: 'actor_type',
          source: 'explicit',
          file: join('types', 'mentor.d.ts'),
          detector: 'identity-role-union',
        }),
      ]),
    );
    expect(ir.role_signals.map((signal) => signal.value)).not.toEqual(
      expect.arrayContaining(['next-env-role', 'generated-role', 'generated-suffix-role']),
    );
  });
});
