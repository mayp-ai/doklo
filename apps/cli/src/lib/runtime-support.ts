import { stat } from 'node:fs/promises';
import type { Framework } from '@doklo-beta/core';
import { detectFramework, frameworkDisplayName } from './framework.js';
import { resolveLocale } from './context.js';
import { createI18n } from './i18n.js';

export interface RuntimeSupportInspection { framework: Framework; nodeVersion: string; }

export class UnsupportedRuntimeError extends Error {
  readonly code = 'UNSUPPORTED_RUNTIME' as const;

  constructor(version: string, minimumVersion: string) {
    super(`Unsupported Node.js runtime ${version}; Doklo requires Node.js >=${minimumVersion}.`);
    this.name = 'UnsupportedRuntimeError';
  }
}

export class UnsupportedFrameworkError extends Error {
  readonly code = 'UNSUPPORTED_FRAMEWORK' as const;
  readonly details: Readonly<{ framework: Framework; monorepoApps: readonly string[] }>;

  /**
   * @param monorepoApps Next.js app-router packages found below the inspected
   *   root. A monorepo root carries no `next` dependency, so "framework
   *   unknown" is technically right and practically a dead end — naming the
   *   apps turns the failure into the next command to run.
   */
  constructor(framework: Framework, monorepoApps: readonly string[] = []) {
    super(unsupportedFrameworkMessage(framework, monorepoApps));
    this.name = 'UnsupportedFrameworkError';
    this.details = Object.freeze({ framework, monorepoApps: Object.freeze([...monorepoApps]) });
  }
}

function unsupportedFrameworkMessage(
  framework: Framework,
  monorepoApps: readonly string[],
): string {
  const t = createI18n(resolveLocale());
  const base = framework === 'unknown'
    ? t('runtime.unsupported_framework.unknown')
    : t('runtime.unsupported_framework.detected', {
        name: frameworkDisplayName(framework),
      });
  if (monorepoApps.length === 0) return base;
  const first = monorepoApps[0] as string;
  return `${base} This looks like a monorepo — found ${monorepoApps.length} Next.js app(s): `
    + `${monorepoApps.join(', ')}. Run \`doklo init --root ${first}\` instead.`;
}

export function assertSupportedFramework(
  framework: Framework,
  monorepoApps: readonly string[] = [],
): void {
  // Framework is descriptive metadata. Specialist availability is not admission.
  void framework;
  void monorepoApps;
}

export function assertSupportedNode(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new UnsupportedRuntimeError(version, '20.9.0');
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supported =
    major > 20 ||
    (major === 20 && (minor > 9 || (minor === 9 && patch >= 0)));
  if (!supported) {
    throw new UnsupportedRuntimeError(version, '20.9.0');
  }
}

export async function assertSupportedRuntimeProject(
  rootDir: string,
): Promise<RuntimeSupportInspection> {
  assertSupportedNode();
  if (!(await stat(rootDir)).isDirectory()) throw new Error('Project root must be a directory.');
  return {
    framework: await detectFramework(rootDir),
    nodeVersion: process.versions.node,
  };
}
