// Canonical layout for a doklo workspace on disk.
//
//   <root>/workspace.json                          ← workspace config
//   <root>/.doklo/hub/                             ← 5-Layer Hub root
//     ├── doks/<DOK-ID>.json                       ← per-Dok files
//     ├── roles.json                               ← roles registry
//     ├── lexicon.json                             ← lexicon
//     └── services/<service-id>/
//          ├── code-mapping.json
//          └── ia.json
//   <root>/.doklo/cache/                           ← intermediate snapshots
//   <root>/.doklo/debug/                           ← LLM debug records
//   <root>/.doklo/livedocs/publications/<name>.json ← committed Publication source
//   <root>/.doklo/.gitignore                       ← allowlist: commit hub/, ignore the rest

import { resolve, join } from 'node:path';

export interface WorkspacePaths {
  root: string;
  workspaceFile: string;
  doklo: string;
  gitignoreFile: string;
  hubRoot: string;
  doksDir: string;
  rolesFile: string;
  lexiconFile: string;
  servicesDir: string;
  cacheDir: string;
  generationLedgerFile: string;
  debugDir: string;
  livedocsDir: string;
  publicationsDir: string;
  serviceCodeMapping: (serviceId: string) => string;
  serviceIa: (serviceId: string) => string;
  serviceDir: (serviceId: string) => string;
  dokFile: (dokId: string) => string;
  publicationFile: (name: string) => string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const absRoot = resolve(root);
  const doklo = join(absRoot, '.doklo');
  const hubRoot = join(doklo, 'hub');
  const servicesDir = join(hubRoot, 'services');
  const livedocsDir = join(doklo, 'livedocs');
  const publicationsDir = join(livedocsDir, 'publications');
  return {
    root: absRoot,
    workspaceFile: join(absRoot, 'workspace.json'),
    doklo,
    gitignoreFile: join(doklo, '.gitignore'),
    hubRoot,
    doksDir: join(hubRoot, 'doks'),
    rolesFile: join(hubRoot, 'roles.json'),
    lexiconFile: join(hubRoot, 'lexicon.json'),
    servicesDir,
    cacheDir: join(doklo, 'cache'),
    generationLedgerFile: join(doklo, 'cache', 'generation-ledger.json'),
    debugDir: join(doklo, 'debug'),
    livedocsDir,
    publicationsDir,
    serviceDir: (serviceId) => join(servicesDir, serviceId),
    serviceCodeMapping: (serviceId) =>
      join(servicesDir, serviceId, 'code-mapping.json'),
    serviceIa: (serviceId) => join(servicesDir, serviceId, 'ia.json'),
    dokFile: (dokId) => join(hubRoot, 'doks', `${dokId}.json`),
    publicationFile: (name) => join(publicationsDir, `${name}.json`),
  };
}
