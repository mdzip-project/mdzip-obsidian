// Editing and organizing an archive: save, new document/folder, rename and
// move (dialogs and drag-and-drop, with two tabs open), delete, entry point.
// Runs on a copy of the Alpha Handbook in the scratch folder.

const COPY = await copyArchive('Projects/Alpha Handbook.mdz', 'Handbook.mdz');
const A = await openFile(COPY);
const read = (p) => A.view.readArchiveText(p);
const pane = async () => {
  if (!ws.getLeavesOfType('mdz-contents').length) {
    await app.commands.executeCommandById('mdzip:show-contents');
    await sleep(800);
  }
  ws.setActiveLeaf(A, { focus: true });
  await sleep(500);
  return ws.getLeavesOfType('mdz-contents')[0].view;
};
const rows = async () => [...(await pane()).contentEl.querySelectorAll('.tree-item-self')].map((e) => e.dataset.path);
/** Drag a row of the contents pane onto a folder row (or the tree, for the root). */
const drag = async (path, folder) => {
  const p = await pane();
  const row = p.contentEl.querySelector(`.tree-item-self[data-path="${path}"]`);
  const target = folder ? p.contentEl.querySelector(`.tree-item-self[data-path="${folder}"]`).parentElement : p.contentEl.querySelector('.mdz-contents-tree');
  const dt = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  target.dispatchEvent(over);
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await sleep(2500);
  return over.defaultPrevented;
};

await check('An edit is autosaved into the archive and survives reopening', async () => {
  const ed = A.view.editor;
  ed.replaceRange('\nEDIT-MARKER-4711\n', { line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
  await sleep(3500);
  await openFile('Home.md', A);
  await openFile(COPY, A);
  const onDisk = [];
  await plugin.catalog.search('EDIT-MARKER-4711', (m) => m.archive === COPY && onDisk.push(m.doc), () => false);
  return { ok: A.view.editor.getValue().includes('EDIT-MARKER-4711') && onDisk.includes('index.md'), detail: onDisk };
});

await check('New document: created from the dialog and opened', async () => {
  void plugin.actions.newDocument(file(COPY), 'guide');
  const desc = await fillPrompt('guide/new-page');
  return { ok: A.view.listDocuments().includes('guide/new-page.md') && A.view.getCurrentDocument() === 'guide/new-page.md', detail: { desc, docs: A.view.listDocuments() } };
});

await check('New document: an existing name (any case) is refused', async () => {
  void plugin.actions.newDocument(file(COPY), 'guide');
  const input = await waitFor(() => lastModal()?.querySelector('.mdz-path-prompt-input'), 3000);
  input.value = 'guide/SETUP.md';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(100);
  const m = lastModal();
  const desc = m.querySelector('.setting-item-description')?.textContent;
  const disabled = [...m.querySelectorAll('button')].find((b) => b.textContent === 'Create').disabled;
  clickButton(m, 'Cancel');
  await sleep(300);
  return { ok: disabled && /already in the archive/.test(desc), detail: desc };
});

await check('Rename guide/setup.md → guide/install.md rewrites links, including [[setup]]', async () => {
  void plugin.actions.rename(file(COPY), 'guide/setup.md', false);
  await fillPrompt('guide/install.md');
  await sleep(500);
  const api = await read('reference/api.md');
  const index = await read('index.md');
  return { ok: api.includes('](../guide/install.md)') && index.includes('[[install]]') && !A.view.listDocuments().includes('guide/setup.md'), detail: { api: linksIn(api), index: linksIn(index) } };
});

await check('Drag to the root with two tabs open: both tabs follow; links rewritten', async () => {
  await A.view.openDocument('guide/install.md');
  await sleep(700);
  const B = ws.getLeaf('tab');
  await openFile(COPY, B);
  await B.view.openDocument('guide/install.md');
  await sleep(700);
  const accepted = await drag('guide/install.md', null);
  const s = { accepted, A: A.view.getCurrentDocument(), B: B.view.getCurrentDocument() };
  B.detach();
  const api = await read('reference/api.md');
  return { ok: accepted && s.A === 'install.md' && s.B === 'install.md' && api.includes('](../install.md)'), detail: { ...s, api: linksIn(api) } };
});

await check('Drag onto a folder moves into it', async () => {
  const accepted = await drag('install.md', 'reference');
  const api = await read('reference/api.md');
  return { ok: accepted && A.view.listDocuments().includes('reference/install.md') && api.includes('](install.md)'), detail: { docs: A.view.listDocuments(), api: linksIn(api) } };
});

await check('New folder appears empty in the pane, and can be deleted', async () => {
  void plugin.actions.newFolder(file(COPY), '');
  await fillPrompt('drafts');
  const added = (await rows()).includes('drafts');
  void plugin.actions.remove(file(COPY), 'drafts', true);
  await waitFor(() => /Delete the folder/.test(lastModal()?.textContent ?? ''), 3000);
  const dialog = lastModal().textContent;
  clickButton(lastModal(), 'Delete');
  await sleep(1500);
  return { ok: added && /nothing else \(it is empty\)/.test(dialog) && !(await rows()).includes('drafts'), detail: dialog.slice(0, 200) };
});

await check('Delete a document after confirming', async () => {
  void plugin.actions.remove(file(COPY), 'guide/new-page.md', false);
  await waitFor(() => /Delete new-page/.test(lastModal()?.textContent ?? ''), 3000);
  clickButton(lastModal(), 'Delete');
  await sleep(1500);
  return { ok: !A.view.listDocuments().includes('guide/new-page.md'), detail: A.view.listDocuments() };
});

await check('The entry point cannot be deleted', async () => {
  const before = modals().length;
  await plugin.actions.remove(file(COPY), 'index.md', false);
  await sleep(500);
  return { ok: modals().length === before && notices().some((n) => /is the entry point/.test(n)), detail: notices().slice(-1) };
});

await check('Make entry point updates the manifest and the pane', async () => {
  await plugin.actions.setEntryPoint(file(COPY), 'reference/install.md');
  await sleep(2000);
  const manifest = JSON.parse(await read('manifest.json'));
  const flagged = (await pane()).contentEl.querySelector('.mdz-contents-flag')?.closest('.tree-item-self')?.dataset.path;
  return { ok: manifest.entryPoint === 'reference/install.md' && flagged === 'reference/install.md', detail: { entryPoint: manifest.entryPoint, flagged } };
});
