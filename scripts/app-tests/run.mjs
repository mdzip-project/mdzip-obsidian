#!/usr/bin/env node
// Runs the in-app test suites against a real Obsidian, over its DevTools port.
//
//   npm run test:app                 # all suites
//   npm run test:app -- graph search # suites whose file name contains a word
//
// Obsidian must either be closed (it is started on the test vault with the
// port open) or already running with --remote-debugging-port=9222. The vault
// must be the generated test vault (it has a `.mdzip-test-vault` marker):
// the suites create and delete files in it, in an `_app-test` folder.
//
// Env: MDZIP_TEST_VAULT (default ../TestVault), OBSIDIAN_EXE, CDP_PORT (9222).

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const vault = resolve(process.env.MDZIP_TEST_VAULT ?? join(repo, '..', 'TestVault'));
const port = Number(process.env.CDP_PORT ?? 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obsidianExe() {
  const candidates = [
    process.env.OBSIDIAN_EXE,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Obsidian', 'Obsidian.exe'),
    '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
    '/usr/bin/obsidian',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    return null;
  }
}

async function connect() {
  let list = await targets();
  if (!list) {
    if (!existsSync(join(vault, '.mdzip-test-vault'))) {
      throw new Error(`No test vault at ${vault}. Make one with: python scripts/make-test-vault.py`);
    }
    const exe = obsidianExe();
    if (!exe) throw new Error('Obsidian not found; set OBSIDIAN_EXE.');
    console.log(`Starting Obsidian on ${vault} ...`);
    const url = `obsidian://open?path=${encodeURIComponent(vault)}`;
    // Without these, Chromium slows timers to a crawl whenever the window is behind others.
    const flags = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
    spawn(exe, [`--remote-debugging-port=${port}`, ...flags, url], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60 && !list; i++) {
      await sleep(500);
      list = await targets();
    }
    if (!list) {
      throw new Error(
        `Obsidian didn't open port ${port}. If it was already running, close it and try again ` +
          `(the port can only be set when it starts).`
      );
    }
    await sleep(4000); // let the vault and plugins load
  }
  const page = list.find((t) => t.type === 'page' && t.url.includes('obsidian.md'));
  if (!page) throw new Error('No Obsidian window on the DevTools port.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const [tag, json] = msg.params.args.map((a) => a.value);
      if (tag === '[app-test]') onProgress(JSON.parse(json));
      return;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
  const evaluate = async (body) => {
    const n = ++id;
    const reply = new Promise((r) => pending.set(n, r));
    ws.send(
      JSON.stringify({
        id: n,
        method: 'Runtime.evaluate',
        params: { expression: `(async () => { ${body} })().then((v) => JSON.stringify(v))`, awaitPromise: true, returnByValue: true },
      })
    );
    const msg = await reply;
    const err = msg.result?.exceptionDetails;
    if (err) throw new Error(err.exception?.description ?? JSON.stringify(err));
    return JSON.parse(msg.result.result.value ?? 'null');
  };
  const command = (method, params = {}) => {
    const n = ++id;
    const reply = new Promise((r) => pending.set(n, r));
    ws.send(JSON.stringify({ id: n, method, params }));
    return reply;
  };
  return { evaluate, command, close: () => ws.close() };
}

let onProgress = () => {};
const lib = readFileSync(join(here, 'lib.js'), 'utf8');
const filters = process.argv.slice(2);
const suites = readdirSync(join(here, 'suites'))
  .filter((f) => f.endsWith('.js'))
  .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
  .sort();

const { evaluate, command, close } = await connect();
// A hidden window gets throttled timers (unless Obsidian was started by this script); show it.
if (await evaluate('return document.hidden;')) {
  await command('Page.bringToFront');
  await sleep(500);
  if (await evaluate('return document.hidden;')) {
    console.warn('Warning: the Obsidian window is hidden, so tests will be slow. Keep it visible, or close Obsidian and let this script start it.');
  }
}
const where = await evaluate(`return { base: app.vault.adapter.basePath, marker: await app.vault.adapter.exists('.mdzip-test-vault') };`);
if (!where.marker) {
  close();
  throw new Error(`Refusing to run: the open vault (${where.base}) isn't a test vault (no .mdzip-test-vault).`);
}
console.log(`Vault: ${where.base}`);
// Load the freshly built plugin.
await evaluate(`await app.plugins.disablePlugin('mdzip'); await app.plugins.enablePlugin('mdzip'); await new Promise((r) => setTimeout(r, 2500)); return true;`);

let failed = 0;
let passed = 0;
for (const suite of suites) {
  const body = readFileSync(join(here, 'suites', suite), 'utf8');
  console.log(`\n${suite}`);
  let results;
  const streamed = [];
  onProgress = (r) => {
    streamed.push(r);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || process.env.VERBOSE) console.log(`       ${JSON.stringify(r.detail)?.slice(0, 1500)}`);
  };
  try {
    const run = evaluate(`${lib}\ntry {\n${body}\n} finally { await cleanup(); }\nreturn results;`);
    let timer;
    const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('suite timed out after 5 minutes')), 300000)));
    try {
      results = await Promise.race([run, limit]);
    } finally {
      clearTimeout(timer); // or Node waits for it before exiting
    }
  } catch (err) {
    results = [...streamed, { name: 'suite crashed', ok: false, detail: String(err.message ?? err).slice(0, 800) }];
    onProgress(results[results.length - 1]);
  }
  for (const r of results) {
    if (r.ok) passed++;
    else failed++;
  }
}
close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
