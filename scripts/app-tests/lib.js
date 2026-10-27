// Helpers prepended to every suite. Suites run inside Obsidian as the body of
// an async function, with `app` in scope, and push to `results` via check().

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const CHECK_TIMEOUT = 30000;
const check = async (name, fn) => {
  try {
    const out = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT / 1000}s`)), CHECK_TIMEOUT)),
    ]);
    results.push({ name, ok: out?.ok !== false, detail: out?.detail ?? out });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.stack ?? e).slice(0, 600) });
  }
  const r = results[results.length - 1];
  console.debug('[app-test]', JSON.stringify(r)); // streamed by run.mjs
};
const ws = app.workspace;
const plugin = app.plugins.plugins.mdzip;
const file = (p) => app.vault.getAbstractFileByPath(p);
const mainLeaf = () => ws.getMostRecentLeaf(ws.rootSplit) ?? ws.getLeaf(false);
/** Open a vault file in the main tab and wait for it to load. */
const openFile = async (p, leaf = mainLeaf()) => {
  await leaf.openFile(file(p));
  ws.setActiveLeaf(leaf, { focus: true });
  await sleep(900);
  return leaf;
};
const state = (leaf = mainLeaf()) => ({
  type: leaf.view.getViewType(),
  file: leaf.view.file?.path,
  doc: leaf.view.getCurrentDocument?.(),
  error: leaf.view.contentEl.querySelector('.mdz-error')?.textContent?.trim() ?? null,
});
const fileCount = () => app.vault.getFiles().length;
const notices = () => [...document.querySelectorAll('.notice')].map((n) => n.textContent);
const modals = () => [...document.querySelectorAll('.modal-container')];
const lastModal = () => modals().pop()?.querySelector('.modal');
const clickButton = (root, text) => {
  const b = [...(root?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
};
const waitFor = async (test, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await test();
    if (v) return v;
    await sleep(100);
  }
  return null;
};
/** Fill the plugin's path dialog and press Enter. Returns the line under the field. */
const fillPrompt = async (value) => {
  const input = await waitFor(() => lastModal()?.querySelector('.mdz-path-prompt-input'), 3000);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(100);
  const desc = lastModal().querySelector('.setting-item-description')?.textContent;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(1500);
  return desc;
};
/** A small PNG as a File, for paste tests. */
const pngFile = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  canvas.getContext('2d').fillRect(0, 0, 8, 8);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new File([blob], 'image.png', { type: 'image/png' });
};
const pasteImage = async (view) => {
  const dt = new DataTransfer();
  dt.items.add(await pngFile());
  const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  const ed = view.editor;
  ed.setCursor({ line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
  ws.trigger('editor-paste', evt, ed, view);
  return evt;
};
const linksIn = (text) => text.match(/\[[^\]]*\]\([^)]*\)|\[\[[^\]]*\]\]/g) ?? [];

// Scratch space: everything a suite creates goes here; cleanup() removes it.
const SCRATCH = '_app-test';
const scratch = async () => {
  if (!file(SCRATCH)) await app.vault.createFolder(SCRATCH);
  return SCRATCH;
};
const copyArchive = async (from, name) => {
  await scratch();
  const to = `${SCRATCH}/${name}`;
  await app.vault.copy(file(from), to);
  await sleep(500);
  return to;
};
const savedConfig = {};
/** Change an Obsidian setting for this suite; cleanup() restores it. */
const setConfig = (key, value) => {
  if (!(key in savedConfig)) savedConfig[key] = app.vault.getConfig(key);
  app.vault.setConfig(key, value);
};
const cleanup = async () => {
  for (const m of modals().reverse()) {
    const modal = m.querySelector('.modal');
    if (!['Cancel', 'Do not update', 'Paste normally'].some((t) => clickButton(modal, t))) m.querySelector('.modal-close-button')?.click();
    await sleep(200);
  }
  for (const [k, v] of Object.entries(savedConfig)) app.vault.setConfig(k, v);
  for (const leaf of ws.getLeavesOfType('mdz-document').concat(ws.getLeavesOfType('markdown'))) {
    if (leaf.view.file?.path.startsWith(SCRATCH + '/')) await leaf.openFile(file('Home.md'));
  }
  for (const leaf of ws.getLeavesOfType('graph')) leaf.detach();
  const pane = ws.getLeavesOfType('mdz-contents')[0]?.view;
  const input = pane?.contentEl.querySelector('.mdz-contents-search input');
  if (input && input.offsetParent) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  await sleep(300);
  if (file(SCRATCH)) await app.vault.delete(file(SCRATCH), true);
};
