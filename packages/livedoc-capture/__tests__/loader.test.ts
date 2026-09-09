import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureConfigNotFoundError, loadCaptureConfig } from '../src/loader.js';

async function tmp<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(join(tmpdir(), 'capload-'));
  try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const YAML = `base_url: http://localhost:5030
auth:
  type: login_form
  url: /auth/signin
  email_selector: 'input[name="email"]'
  password_selector: 'input[name="password"]'
  submit_selector: 'button[type="submit"]'
  email: user@example.com
  password: secret
doks:
  ADMIN-BANN:
    viewport:
      width: 1280
      height: 800
    steps:
      - step: 1
        url: /admin/banner
        wait_for: .banner-table
        highlight: 'button:has-text("새 배너 추가")'
`;

describe('loadCaptureConfig', () => {
  it('loads .doklo/capture.yaml', async () => {
    await tmp(async (root) => {
      await mkdir(join(root, '.doklo'), { recursive: true });
      await writeFile(join(root, '.doklo', 'capture.yaml'), YAML);
      const cfg = await loadCaptureConfig(root);
      expect(cfg.base_url).toBe('http://localhost:5030');
      expect(cfg.doks['ADMIN-BANN']!.steps[0]!.url).toBe('/admin/banner');
    });
  });

  it('throws CaptureConfigNotFoundError when no file present', async () => {
    await tmp(async (root) => {
      await expect(loadCaptureConfig(root)).rejects.toBeInstanceOf(CaptureConfigNotFoundError);
    });
  });

  it('resolves env indirection for credentials', async () => {
    await tmp(async (root) => {
      await mkdir(join(root, '.doklo'), { recursive: true });
      await writeFile(
        join(root, '.doklo', 'capture.yaml'),
        `base_url: http://x
auth:
  type: login_form
  url: /s
  email_selector: '#e'
  password_selector: '#p'
  submit_selector: '#b'
  email_env: TEST_LIVE_DOCS_USER
  password_env: TEST_LIVE_DOCS_PASS
`,
      );
      process.env['TEST_LIVE_DOCS_USER'] = 'env-user';
      process.env['TEST_LIVE_DOCS_PASS'] = 'env-pass';
      try {
        const cfg = await loadCaptureConfig(root);
        if (cfg.auth.type === 'login_form') {
          expect(cfg.auth.email).toBe('env-user');
          expect(cfg.auth.password).toBe('env-pass');
        }
      } finally {
        delete process.env['TEST_LIVE_DOCS_USER'];
        delete process.env['TEST_LIVE_DOCS_PASS'];
      }
    });
  });
});
