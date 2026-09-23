import { describe, expect, it } from 'vitest';
import { isSensitiveSourcePath } from '../src/fs/source-policy.js';

describe('source path policy', () => {
  it.each([
    '.envrc', 'deploy/.envrc.local', 'terraform.tfvars', 'infra/prod.auto.tfvars.json',
    'config/serviceAccount.json', 'service-account-key.json', 'service_account_key.json',
    'serviceAccountKey.production.json', 'my-project-firebase-adminsdk-abc-123.json',
    'application_default_credentials.json', '.config/gcloud/configurations/config_default',
    'local.settings.json', 'settings.local.json', 'config/local_settings.py',
    'config/settings_local.py', 'config/settings.local.php', 'wp-config.php',
    'config/master.key', 'config/credentials.yml.enc', '.ENV.production',
    'C:\\project\\CONFIG\\SERVICEACCOUNTKEY.JSON',
  ])('excludes credential-bearing path %s', path => {
    expect(isSensitiveSourcePath(path)).toBe(true);
  });

  it.each([
    'src/auth.ts', 'src/auth.config.ts', 'src/authentication.py', 'src/authorization.go',
    'src/service-account.ts', 'src/serviceAccountController.java', 'src/firebase-admin.ts',
    'config/settings.py', 'config/settings.json', 'config/localization.ts',
    'app.config.ts', 'package.json', 'tsconfig.json', 'infra/main.tf', 'src/environment.ts',
  ])('preserves ordinary business source %s', path => {
    expect(isSensitiveSourcePath(path)).toBe(false);
  });
});
