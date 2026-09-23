import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const [cli, workspace] = process.argv.slice(2);
if (!cli || !workspace) throw new Error('Usage: release-studio-smoke.mjs <installed doklo bin> <workspace>');
const socket = createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(cli, ['serve', '--root', workspace, '--port', String(port)], { stdio: 'inherit' });
let spawnError;
child.on('error', (error) => { spawnError = error; });
const base = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Installed Studio exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/doks`, { signal: AbortSignal.timeout(2_000) });
      await response.text();
      if (response.ok) break;
    } catch { /* Server is still starting; bounded by deadline. */ }
    if (Date.now() > deadline) throw new Error('Installed Studio did not become ready');
    await delay(250);
  }
  for (const path of ['/doks', '/livedocs']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
    const html = await response.text();
    if (!response.ok || !html.includes('Doklo') || /Application error|NEXT_HTTP_ERROR_FALLBACK/.test(html)) {
      throw new Error(`Installed Studio ${path} failed: HTTP ${response.status}`);
    }
    const assets = [...html.matchAll(/<script[^>]+src="([^\"]+)"/g)].map((match) => match[1]);
    if (!assets.length) throw new Error(`Installed Studio ${path} has no script assets`);
    for (const asset of assets.slice(0, 2)) {
      const result = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(10_000) });
      await result.arrayBuffer();
      if (!result.ok) throw new Error(`Installed Studio asset failed: ${asset}`);
    }
    console.log(JSON.stringify({ path, status: response.status, assetsChecked: Math.min(assets.length, 2) }));
  }
} finally {
  child.kill('SIGTERM');
}
