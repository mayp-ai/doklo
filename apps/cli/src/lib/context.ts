// Shared execution context passed to every command.
//
// Today this is just i18n. As the CLI grows we'll add things like:
// telemetry handles, debug mode flags, etc.

import { createI18n, type I18nLocale, type I18nT } from './i18n.js';

export interface CliContext {
  locale: I18nLocale;
  t: I18nT;
}

export function createContext(locale: I18nLocale): CliContext {
  return { locale, t: createI18n(locale) };
}

export function resolveLocale(env: NodeJS.ProcessEnv = process.env): I18nLocale {
  // English is the CLI's default chrome language for the OSS release. Korean is
  // opt-in only, via an explicit DOKLO_LOCALE=ko — we deliberately do NOT
  // auto-switch on OS LANG, so output stays predictable for demos and for
  // global users. (Workspace/content locale is separate; see live-docs-render.)
  const override = env['DOKLO_LOCALE'];
  if (override === 'ko' || override === 'en') return override;
  return 'en';
}
