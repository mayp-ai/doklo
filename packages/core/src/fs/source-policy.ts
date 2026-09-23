/** Path-only policy: runs before opening source, including on cached references.
 * This cannot identify secrets embedded in arbitrarily named application source.
 */
export function isSensitiveSourcePath(file: string): boolean {
  const parts = file.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  const base = parts.at(-1) ?? '';
  if (/^\.env(?:rc)?(?:\.|$)/.test(base)) return true;
  if (/\.(?:pem|key|p8|p12|pfx|jks|keystore|crt|cer|properties|tfstate|tfvars)(?:\..*)?$/.test(base)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(?:[._-]|$)/.test(base)) return true;
  if (/^(?:application|appsettings|database)(?:[.-].*)?\.(?:json|ya?ml)$/.test(base)) return true;
  if (['.npmrc', '.pypirc', '.netrc', '.pgpass', '.my.cnf'].includes(base)) return true;
  // Credential exports and local overrides have conventional names across
  // ecosystems. Keep normal auth modules and general config source readable.
  if (/^service[._-]?account(?:[._-]?key)?(?:[._-].*)?\.json$/.test(base)) return true;
  if (/(?:^|-)firebase-adminsdk-[^.]+\.json$/.test(base)) return true;
  if (base === 'application_default_credentials.json') return true;
  if (/^(?:local[._-]settings|settings[._-]local)\.(?:json|ya?ml|py|php)$/.test(base)) return true;
  if (base === 'wp-config.php') return true;
  if (parts.some((part, index) => part === '.config' && parts[index + 1] === 'gcloud')) return true;
  return parts.slice(0, -1).some(part => [
    '.ssh', '.aws', '.azure', '.gcloud', '.kube', '.gnupg',
    'cert', 'certs', 'certificate', 'certificates', 'keys', 'secrets',
  ].includes(part));
}

export const EXCLUDED_SOURCE_DIRS: ReadonlySet<string> = new Set(['.git', '.doklo', '.claude', '.codex', '.agents', '.worktrees',
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', 'target', 'vendor', '.idea', '.vscode']);
const EXCLUDED_SOURCE_FILES = new Set(['workspace.json', '.gitignore', '.gitattributes', '.DS_Store',
  '.npmrc', '.pypirc', '.netrc', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock']);

/** Shared path exclusions for discovery, generation, and source drift reads. */
export function isExcludedSourcePath(file: string): boolean {
  const parts = file.replaceAll('\\', '/').split('/');
  return isSensitiveSourcePath(file)
    || parts.some(part => EXCLUDED_SOURCE_DIRS.has(part))
    || EXCLUDED_SOURCE_FILES.has(parts.at(-1) ?? '');
}
