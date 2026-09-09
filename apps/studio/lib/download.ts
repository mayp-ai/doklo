// Client-side helper: hand a self-contained HTML document to the browser
// as a file download. Shared by the onboarding wizard's Live Docs step and
// the Studio /livedocs page.

import type { WizardLivedoc } from './livedoc-templates';

export function triggerDownload({ html, filename }: WizardLivedoc): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
