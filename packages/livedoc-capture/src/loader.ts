import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseCaptureConfig, type CaptureConfig } from './config.js';

export class CaptureConfigNotFoundError extends Error {
  constructor(public searched: string[]) {
    super(`No capture config found. Searched:\n  ${searched.join('\n  ')}`);
    this.name = 'CaptureConfigNotFoundError';
  }
}

/**
 * Load `<workspaceRoot>/.doklo/capture.{yaml,yml,json}`.
 *
 * Throws CaptureConfigNotFoundError when none of the expected paths exist.
 */
export async function loadCaptureConfig(workspaceRoot: string): Promise<CaptureConfig> {
  const candidates = [
    join(workspaceRoot, '.doklo', 'capture.yaml'),
    join(workspaceRoot, '.doklo', 'capture.yml'),
    join(workspaceRoot, '.doklo', 'capture.json'),
  ];
  for (const path of candidates) {
    if (await fileExists(path)) {
      const raw = await readFile(path, 'utf-8');
      const parsed = path.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      // Resolve env-var indirections so the orchestrator gets concrete creds.
      return resolveEnvIndirections(parseCaptureConfig(parsed));
    }
  }
  throw new CaptureConfigNotFoundError(candidates);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function resolveEnvIndirections(cfg: CaptureConfig): CaptureConfig {
  if (cfg.auth.type === 'login_form') {
    if (cfg.auth.email_env && !cfg.auth.email) {
      cfg.auth.email = process.env[cfg.auth.email_env];
    }
    if (cfg.auth.password_env && !cfg.auth.password) {
      cfg.auth.password = process.env[cfg.auth.password_env];
    }
  } else if (cfg.auth.type === 'cookie') {
    for (const c of cfg.auth.cookies) {
      if (c.value_env && !c.value) {
        c.value = process.env[c.value_env];
      }
    }
  }
  return cfg;
}
