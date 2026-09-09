import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseCaptureConfig } from '../src/config.js';

describe('parseCaptureConfig', () => {
  it('describes the package as experimental and currently unavailable', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ));
    expect(packageJson.description).toContain('Experimental');
    expect(packageJson.description).toContain('currently unavailable');
    expect(packageJson.description).not.toContain('pipeline');
  });

  it('does not ship Playwright as a runtime dependency while capture is fail-closed', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ));
    expect(packageJson.dependencies).not.toHaveProperty('playwright');
  });

  it('parses minimal config with no auth + no doks', () => {
    const cfg = parseCaptureConfig({ base_url: 'http://localhost:3000' });
    expect(cfg.base_url).toBe('http://localhost:3000');
    expect(cfg.auth.type).toBe('none');
    expect(cfg.doks).toEqual({});
  });

  it('parses login_form auth with env indirection', () => {
    const cfg = parseCaptureConfig({
      base_url: 'http://localhost:3000',
      auth: {
        type: 'login_form',
        url: '/auth/signin',
        email_selector: 'input[name="email"]',
        password_selector: 'input[name="password"]',
        submit_selector: 'button[type="submit"]',
        email_env: 'LIVE_DOCS_USER',
        password_env: 'LIVE_DOCS_PASS',
      },
    });
    expect(cfg.auth.type).toBe('login_form');
    if (cfg.auth.type === 'login_form') {
      expect(cfg.auth.email_env).toBe('LIVE_DOCS_USER');
    }
  });

  it('parses cookie auth', () => {
    const cfg = parseCaptureConfig({
      base_url: 'http://localhost:3000',
      auth: {
        type: 'cookie',
        cookies: [{ name: 'session', value: 'abc', domain: 'localhost', path: '/' }],
      },
    });
    expect(cfg.auth.type).toBe('cookie');
  });

  it('parses dok recipe with step actions', () => {
    const cfg = parseCaptureConfig({
      base_url: 'http://localhost:3000',
      doks: {
        'DOK': {
          viewport: { width: 1280, height: 800 },
          steps: [
            {
              step: 1,
              url: '/admin/banner',
              wait_for: '.banner-table',
              highlight: 'button.add',
              actions: [
                { type: 'wait', ms: 200 },
                { type: 'click', selector: '.add' },
                { type: 'fill', selector: '#title', value: 'New' },
              ],
            },
          ],
        },
      },
    });
    expect(cfg.doks['DOK']!.steps).toHaveLength(1);
    expect(cfg.doks['DOK']!.steps[0]!.actions).toHaveLength(3);
    expect(cfg.doks['DOK']!.steps[0]!.highlight).toBe('button.add');
  });

  it('rejects unknown action type', () => {
    expect(() =>
      parseCaptureConfig({
        base_url: 'http://localhost:3000',
        doks: {
          'DOK': {
            steps: [{ step: 1, actions: [{ type: 'nuke', selector: '*' }] }],
          },
        },
      }),
    ).toThrow();
  });

  it('rejects empty steps array', () => {
    expect(() =>
      parseCaptureConfig({
        base_url: 'http://localhost:3000',
        doks: { 'DOK': { steps: [] } },
      }),
    ).toThrow();
  });

  it('parses a dok recipe with a platforms viewport map', () => {
    const cfg = parseCaptureConfig({
      base_url: 'http://localhost:5030',
      doks: {
        'DOK': {
          platforms: {
            desktop: { width: 1280, height: 800 },
            mobile: { width: 390, height: 844 },
          },
          steps: [{ step: 1, url: '/x' }],
        },
      },
    });
    const recipe = cfg.doks['DOK']!;
    expect(recipe.platforms).toBeDefined();
    expect(Object.keys(recipe.platforms!).sort()).toEqual(['desktop', 'mobile']);
    expect(recipe.platforms!['mobile']).toEqual({ width: 390, height: 844 });
  });

  it.each([
    '../outside',
    '/tmp/outside',
    'C:\\outside',
    'AUTH\\001',
    'AUTH/001',
    'AUTH\0-001',
    'auth-001',
  ])('rejects unsafe or non-canonical Dok key %j', (dokId) => {
    expect(() =>
      parseCaptureConfig({
        base_url: 'http://localhost:5030',
        doks: { [dokId]: { steps: [{ step: 1 }] } },
      }),
    ).toThrow();
  });

  it.each(['../mobile', '/mobile', 'mobile/phone', 'mobile\\phone', 'mobile\0phone', '.', '..'])
    ('rejects unsafe platform label %j', (platform) => {
      expect(() =>
        parseCaptureConfig({
          base_url: 'http://localhost:5030',
          doks: {
            'DOK': {
              platforms: { [platform]: { width: 390, height: 844 } },
              steps: [{ step: 1 }],
            },
          },
        }),
      ).toThrow();
    });

  it('rejects duplicate step numbers before they can alias output paths', () => {
    expect(() =>
      parseCaptureConfig({
        base_url: 'http://localhost:5030',
        doks: {
          'DOK': {
            steps: [
              { step: 1, url: '/first' },
              { step: 1, url: '/second' },
            ],
          },
        },
      }),
    ).toThrow(/step/i);
  });
});
