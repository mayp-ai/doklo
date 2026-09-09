#!/usr/bin/env node

// Dok change-history pipeline — real-browser acceptance.
//
// The propose-and-approve model (design §0b) only holds if a person can do it
// with a mouse: type a note, save, watch the entry land in the file; see a
// staged proposal, activate, watch it become history. Unit tests assert the
// server actions; this script asserts the surface a person actually touches.
//
// Runs against the bundled sample workspace copied out of the repository, so
// the shipped demo bytes stay untouched (asserted at the end).
//
// Usage: node apps/studio/e2e/dok-history-note.mjs
//   DOKLO_E2E_RUN_DIR   where the workspace copy and screenshots go
//                       (default: /tmp/mayp42)

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { computeChangeProposal } from '@doklo-beta/core';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '..', '..', '..');
const demo = join(repository, 'apps', 'studio', 'demo');
const studioServers = [
  join(repository, 'apps', 'studio', '.next', 'standalone', 'apps', 'studio', 'server.js'),
  join(repository, 'apps', 'studio', '.next', 'standalone', 'server.js'),
];
const timeout = 20_000;
const runRoot = process.env.DOKLO_E2E_RUN_DIR || '/tmp/mayp42';
const workspace = join(runRoot, 'ws');
// The Dok a person edits with a note. Active with one legacy history entry.
const NOTE_DOK = 'AUTH-FORGOT';
// The Dok a regeneration staged a proposal on. Emptied history + a proposal
// whose `previous_status` is active — the legacy-Dok case lazy baseline (§7.4)
// exists for.
const PROPOSAL_DOK = 'SHOP-CART-PAY';

const demoBefore = await snapshotBytes(demo);
const report = {
  schema_version: 1,
  status: 'running',
  workspace,
  assertions: [],
  browser_errors: [],
  screenshots: [],
  files: {},
};
let browser;
let studio;
let page;

try {
  const serverJs = await firstExisting(studioServers);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(demo, workspace, { recursive: true });
  const proposal = await seedProposal(PROPOSAL_DOK);
  report.files.seeded_proposal = proposal;

  const port = await reservePort();
  studio = await startStudio({ serverJs, workspace, port });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => report.browser_errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.browser_errors.push(message.text());
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  await check('A note with no other edit saves and records an `edited` entry', async () => {
    await page.goto(`${baseUrl}/doks/${NOTE_DOK}`, { waitUntil: 'domcontentloaded' });
    await visible(page.getByRole('navigation', { name: 'Dok editor actions' }));
    const before = await readDok(NOTE_DOK);
    assert(before.status === 'active', `${NOTE_DOK} did not start active.`);
    assert(
      await saveButton(page).textContent() === 'Saved',
      'The action bar offered a save before anything changed.',
    );
    await page.locator('input[name="change-note"]').fill('Reset link expiry raised to 30 minutes');
    await page.locator('select[name="change-category"]').selectOption('fixed');
    await shot('01-note-typed');
    assert(
      await saveButton(page).textContent() === 'Save',
      'A note alone did not enable the save.',
    );
    await saveButton(page).click();
    await poll(async () => (await readDok(NOTE_DOK))._meta.version === before._meta.version + 1,
      'The note-only save never reached the file.');
    const after = await readDok(NOTE_DOK);
    const entry = last(after._meta.history);
    assert(after._meta.version === 2, `version ${after._meta.version} ≠ 2.`);
    assert(entry.version === 2, `entry version ${entry.version} ≠ 2.`);
    assert(entry.kind === 'edited', `kind ${entry.kind} ≠ edited.`);
    assert(entry.change === 'Reset link expiry raised to 30 minutes', 'note text lost.');
    assert(entry.category === 'fixed', `category ${entry.category} ≠ fixed.`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), `date ${entry.date} is not YYYY-MM-DD.`);
    assert(after.status === 'active', 'A note-only save demoted the Dok.');
    assert(entry.from === undefined && entry.to === undefined,
      'A save that changed no status still wrote from/to.');
    assert(after._meta.edited_by_human !== true,
      'A note-only save marked the Dok as human-edited.');
    report.files.note_only = { meta: after._meta, status: after.status };
    await shot('02-note-saved');
  });

  await check('An edit plus a note records from/to across the demotion', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Dok name' })
      .fill('Password reset request (revised)');
    await page.locator('input[name="change-note"]').fill('Renamed for the help centre');
    await shot('03-edit-plus-note');
    await saveButton(page).click();
    await poll(async () => (await readDok(NOTE_DOK))._meta.version === 3,
      'The edit+note save never reached the file.');
    const after = await readDok(NOTE_DOK);
    const entry = last(after._meta.history);
    assert(entry.kind === 'edited', `kind ${entry.kind} ≠ edited.`);
    assert(entry.change === 'Renamed for the help centre', 'note text lost.');
    assert(entry.from === 'active' && entry.to === 'draft',
      `from/to ${entry.from}→${entry.to} ≠ active→draft.`);
    assert(entry.category === undefined, 'An unset category was stored anyway.');
    assert(after._meta.edited_by_human === true, 'Authoring did not mark the Dok human-edited.');
    assert(after._meta.history.map((e) => e.version).join(',') === '1,2,3',
      'History versions are not strictly increasing by one.');
    report.files.edited = { meta: after._meta, status: after.status };
    await shot('04-edit-saved');
  });

  await check('A staged proposal shows in the action bar before approval', async () => {
    await page.goto(`${baseUrl}/doks/${PROPOSAL_DOK}`, { waitUntil: 'domcontentloaded' });
    const banner = page.getByTestId('pending-proposal');
    await visible(banner);
    const text = (await banner.innerText()).replace(/\s+/g, ' ').trim();
    assert(text.startsWith(`Proposed: ${proposal.summary}`),
      `Action bar read "${text}" instead of the staged summary.`);
    assert(text.includes('Recorded to history when you activate'),
      'The action bar did not say approval is what records it.');
    report.files.proposal_banner = text;
    await shot('05-proposal-shown');
  });

  await check('Activating confirms the proposal and clears pending_change', async () => {
    await page.getByRole('button', { name: 'Mark reviewed → active', exact: true }).click();
    await saveButton(page).click();
    await poll(async () => (await readDok(PROPOSAL_DOK)).status === 'active',
      'The approval never reached the file.');
    const after = await readDok(PROPOSAL_DOK);
    const [baseline, confirmed] = after._meta.history;
    assert(after._meta.pending_change === undefined,
      'pending_change survived the approval that consumed it.');
    assert(after._meta.history.length === 2,
      `Expected baseline + regenerated, got ${after._meta.history.length} entries.`);
    assert(baseline.kind === 'baseline' && baseline.version === 1,
      'Lazy baseline missing or mis-versioned.');
    assert(confirmed.kind === 'regenerated', `kind ${confirmed.kind} ≠ regenerated.`);
    assert(confirmed.change === proposal.summary,
      `Recorded "${confirmed.change}" instead of the staged summary.`);
    assert(confirmed.from === 'draft' && confirmed.to === 'active',
      `from/to ${confirmed.from}→${confirmed.to} ≠ draft→active.`);
    assert(confirmed.version === after._meta.version,
      '_meta.version and the last entry disagree.');
    report.files.approved = { meta: after._meta, status: after.status };
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert(await page.getByTestId('pending-proposal').count() === 0,
      'The proposal banner outlived the proposal.');
    await shot('06-approved');
  });

  await check('Browser console and the bundled demo workspace are unchanged', async () => {
    assert(report.browser_errors.length === 0,
      `Browser emitted ${report.browser_errors.length} error(s): ${report.browser_errors.join(' | ')}`);
    const demoAfter = await snapshotBytes(demo);
    assert(JSON.stringify([...demoAfter]) === JSON.stringify([...demoBefore]),
      'The bundled demo workspace changed during acceptance.');
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  report.failure_url = page?.url() ?? '';
  if (page) await shot('99-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopStudio(studio).catch(() => {});
  process.stdout.write(`Dok history note E2E result:\n${JSON.stringify(report, null, 2)}\n`);
}

async function check(name, callback) {
  try {
    await callback();
    report.assertions.push({ name, status: 'pass' });
  } catch (error) {
    report.assertions.push({
      name,
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Stage what a regeneration would have staged, using the same core helper the
 * generate path calls — no LLM, no wall clock. The Dok's history is emptied
 * and the proposal remembers an active `previous_status` so approval has to
 * decide the lazy-baseline question a legacy Dok poses (§7.4).
 */
async function seedProposal(dokId) {
  const path = dokPath(dokId);
  const previous = await readJson(path);
  const next = structuredClone(previous);
  next.description = 'Pay for the items in the cart, with the saved card offered first.';
  next.user_actions = {
    steps: [
      {
        step_id: 'STEP-CONFIRM',
        actor: { kind: 'role', role_ref: 'ROLE-SHOPPER' },
        intent: 'Confirm the payment',
      },
    ],
  };
  const proposal = computeChangeProposal(previous, next);
  if (!proposal) throw new Error('The seed edit produced no proposal.');
  previous._meta.history = [];
  previous._meta.pending_change = {
    summary: proposal.summary,
    source: 'diff',
    base_version: previous._meta.version,
    previous_status: 'active',
  };
  await writeJson(path, previous);
  return { dok_id: dokId, ...previous._meta.pending_change };
}

function dokPath(dokId) {
  return join(workspace, '.doklo', 'hub', 'doks', `${dokId}.json`);
}

async function readDok(dokId) {
  return readJson(dokPath(dokId));
}

function last(entries) {
  return entries[entries.length - 1];
}

function saveButton(target) {
  return target.getByRole('navigation', { name: 'Dok editor actions' })
    .getByRole('button')
    .last();
}

async function shot(name) {
  const path = join(runRoot, `shot-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(path);
}

async function snapshotBytes(root) {
  const directory = join(root, '.doklo', 'hub', 'doks');
  const snapshot = new Map();
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.json')) continue;
    snapshot.set(name, await readFile(join(directory, name), 'utf8'));
  }
  return snapshot;
}

async function poll(callback, failureMessage) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await callback()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(failureMessage);
}

async function startStudio({ serverJs, workspace: workspaceRoot, port }) {
  const child = spawn(process.execPath, [serverJs], {
    cwd: dirname(serverJs),
    env: {
      ...process.env,
      DOKLO_WORKSPACE_ROOT: workspaceRoot,
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });
  const url = `http://127.0.0.1:${port}/doks`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged Studio exited during startup. ${stderrTail.trim()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return child;
    } catch {
      // Server is still binding.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  await stopStudio(child);
  throw new Error(`Packaged Studio did not start within 30 seconds. ${stderrTail.trim()}`);
}

async function stopStudio(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  }
}

async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout });
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Try the next standalone layout.
    }
  }
  throw new Error(
    'Packaged Studio server is missing. Run pnpm -C apps/studio build:standalone.',
  );
}

async function reservePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('Could not reserve an E2E port.'));
        return;
      }
      server.close((error) => (error ? rejectPromise(error) : resolvePromise(address.port)));
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
