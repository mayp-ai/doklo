import { describe, it, expect } from 'vitest';
import {
  RouteIRSchema,
  ComponentIRSchema,
  StoreIRSchema,
  ProjectIRSchema,
} from '../src/ir/index.js';

describe('RouteIR', () => {
  it('parses a Next.js page route', () => {
    const result = RouteIRSchema.parse({
      path: '/users/[id]',
      kind: 'page',
      file: 'app/users/[id]/page.tsx',
      dynamic_params: ['id'],
      layout_chain: ['app/layout.tsx'],
      is_server_component: true,
    });
    expect(result.dynamic_params).toEqual(['id']);
    expect(result.is_server_component).toBe(true);
  });

  it('parses an api route with method', () => {
    const result = RouteIRSchema.parse({
      path: '/api/auth/signup',
      kind: 'api',
      http_method: 'POST',
      file: 'app/api/auth/signup/route.ts',
    });
    expect(result.http_method).toBe('POST');
    expect(result.dynamic_params).toEqual([]);
  });

  it('rejects empty path', () => {
    const result = RouteIRSchema.safeParse({
      path: '',
      kind: 'page',
      file: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('ComponentIR', () => {
  it('parses a React component with hooks', () => {
    const result = ComponentIRSchema.parse({
      name: 'SignupForm',
      file: 'components/SignupForm.tsx',
      kind: 'component',
      is_exported: true,
      inputs: [
        { name: 'onSubmit', type: '(data: SignupData) => void', is_optional: false },
      ],
      hooks_used: ['useState', 'useForm'],
    });
    expect(result.hooks_used).toContain('useForm');
    expect(result.inputs[0]?.is_optional).toBe(false);
  });

  it('parses an async function with return type', () => {
    const result = ComponentIRSchema.parse({
      name: 'fetchUser',
      file: 'lib/api.ts',
      kind: 'function',
      is_exported: true,
      is_async: true,
      returns: 'Promise<User>',
    });
    expect(result.is_async).toBe(true);
  });
});

describe('StoreIR', () => {
  it('parses a Zustand store', () => {
    const result = StoreIRSchema.parse({
      name: 'useAuthStore',
      file: 'stores/auth.ts',
      kind: 'zustand',
      state_fields: [
        { name: 'user', type: 'User | null', initial_value: 'null' },
        { name: 'isAuthenticated', type: 'boolean', initial_value: 'false' },
      ],
      actions: [
        { name: 'login', is_async: true, params: [{ name: 'credentials', type: 'Credentials', is_optional: false }] },
        { name: 'logout', params: [] },
      ],
    });
    expect(result.kind).toBe('zustand');
    expect(result.state_fields.length).toBe(2);
    expect(result.actions[0]?.is_async).toBe(true);
  });
});

describe('ProjectIR', () => {
  it('parses a complete Next.js project snapshot', () => {
    const result = ProjectIRSchema.parse({
      framework: 'nextjs',
      framework_version: '14.2.4',
      root: '/Users/x/my-app',
      files: ['app/layout.tsx', 'app/page.tsx'],
      routes: [
        { path: '/', kind: 'page', file: 'app/page.tsx' },
      ],
      components: [
        { name: 'HomePage', file: 'app/page.tsx', kind: 'component', is_exported: true },
      ],
      stores: [],
    });
    expect(result.framework).toBe('nextjs');
    expect(result.routes.length).toBe(1);
  });

  it('accepts framework_specific extras without losing them', () => {
    const result = ProjectIRSchema.parse({
      framework: 'nextjs',
      root: '.',
      framework_specific: {
        next_config: { reactStrictMode: true },
        middleware_matchers: ['/api/:path*'],
      },
    });
    expect(result.framework_specific?.next_config).toBeDefined();
  });

  it('defaults role_signals and parses explicit facts', () => {
    const empty = ProjectIRSchema.parse({ framework: 'nextjs', root: '.' });
    expect(empty.role_signals).toEqual([]);

    const parsed = ProjectIRSchema.parse({
      framework: 'nextjs',
      root: '.',
      role_signals: [{
        value: 'mentor',
        kind: 'actor_type',
        source: 'explicit',
        file: 'types/mentor.d.ts',
        line: 7,
        detector: 'identity-string-union',
      }],
    });
    expect(parsed.role_signals[0]?.value).toBe('mentor');
  });

  it('rejects unknown framework', () => {
    const result = ProjectIRSchema.safeParse({
      framework: 'cobol',
      root: '.',
    });
    expect(result.success).toBe(false);
  });
});
