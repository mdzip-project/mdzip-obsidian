// Test Plan: "Opening and editing", "Projects and documents", "Links across the archive boundary".
// Read-only: nothing in the vault is changed.

/** Follow a link written in an archive document, as a click would (the source is the archive's path). */
const follow = async (archive, doc, link) => {
  const leaf = await openFile(archive);
  if (doc) {
    await leaf.view.openDocument(doc);
    await sleep(600);
  }
  const n = fileCount();
  await leaf.openLinkText(link, archive, false);
  await sleep(900);
  return { ...state(), newFiles: fileCount() - n };
};

await check('Field Guide opens in the MDZip view with the Obsidian editor', async () => {
  const leaf = await openFile('Archives/Field Guide.mdz');
  const text = leaf.view.editor?.getValue() ?? '';
  return { ok: state(leaf).type === 'mdz-document' && text.startsWith('# Field Guide'), detail: state(leaf) };
});

await check('Field Guide images load (live preview)', async () => {
  await sleep(800);
  // CodeMirror adds empty <img class="cm-widgetBuffer"> placeholders; only real images have a src.
  const imgs = [...mainLeaf().view.contentEl.querySelectorAll('img[src]')];
  return { ok: imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0), detail: imgs.map((i) => i.src.slice(0, 40)) };
});

await check('Reading view and source mode stay in the MDZip view', async () => {
  const leaf = mainLeaf();
  const set = (extra) => leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, ...extra } });
  await set({ mode: 'preview' });
  await sleep(800);
  const reading = { type: leaf.view.getViewType(), mode: leaf.view.getMode(), images: [...leaf.view.contentEl.querySelectorAll('.markdown-reading-view img')].filter((i) => i.naturalWidth > 0).length };
  await set({ mode: 'source', source: true });
  await sleep(600);
  const source = { type: leaf.view.getViewType(), zipText: (leaf.view.editor?.getValue() ?? '').startsWith('PK') };
  await set({ mode: 'source', source: false });
  await sleep(400);
  return { ok: reading.type === 'mdz-document' && reading.mode === 'preview' && reading.images > 0 && source.type === 'mdz-document' && !source.zipText, detail: { reading, source } };
});

await check('Broken.mdz shows an error banner', async () => {
  const s = state(await openFile('Archives/Broken.mdz'));
  return { ok: /ERR_ZIP_INVALID/.test(s.error ?? ''), detail: s };
});

await check('Missing Entry.mdz shows an entryPoint error banner', async () => {
  const s = state(await openFile('Archives/Missing Entry.mdz'));
  return { ok: /ERR_ENTRYPOINT_MISSING/.test(s.error ?? ''), detail: s };
});

await check('Word count is the document, not the ZIP', async () => {
  const leaf = await openFile('Archives/Field Guide.mdz');
  await sleep(600);
  const bar = document.querySelector('.status-bar-item.plugin-word-count')?.textContent ?? '';
  const chars = Number(/([\d,]+) characters/.exec(bar)?.[1].replace(/,/g, ''));
  return { ok: chars === leaf.view.editor.getValue().length, detail: { bar, chars: leaf.view.editor.getValue().length } };
});

await check('Alpha Handbook opens as a project with its documents', async () => {
  const v = (await openFile('Projects/Alpha Handbook.mdz')).view;
  return { ok: v.getArchiveMode() === 'project' && v.listDocuments().length === 4 && v.getCurrentDocument() === 'index.md', detail: { mode: v.getArchiveMode(), docs: v.listDocuments() } };
});

await check('[[setup]] inside the handbook opens guide/setup.md', async () => {
  const s = await follow('Projects/Alpha Handbook.mdz', 'index.md', 'setup');
  return { ok: s.doc === 'guide/setup.md' && s.newFiles === 0, detail: s };
});

await check('Back and forward move between archive documents', async () => {
  const leaf = mainLeaf();
  const before = state().doc;
  leaf.history.back();
  await sleep(900);
  const back = state().doc;
  leaf.history.forward();
  await sleep(900);
  return { ok: before === 'guide/setup.md' && back === 'index.md' && state().doc === before, detail: { before, back, forward: state().doc } };
});

await check('Field Guide → ../../People/Ada Lovelace.md opens the vault note', async () => {
  const s = await follow('Archives/Field Guide.mdz', null, '../../People/Ada%20Lovelace.md');
  return { ok: s.file === 'People/Ada Lovelace.md', detail: s };
});

await check('Field Guide → a document in Alpha Handbook opens it', async () => {
  const s = await follow('Archives/Field Guide.mdz', null, '../../Projects/Alpha%20Handbook.mdz/guide/setup.md');
  return { ok: s.file === 'Projects/Alpha Handbook.mdz' && s.doc === 'guide/setup.md', detail: s };
});

await check('A missing link from an archive creates no note', async () => {
  const s = await follow('Archives/Field Guide.mdz', null, '../Missing.md');
  return { ok: s.newFiles === 0 && s.file === 'Archives/Field Guide.mdz', detail: s };
});

await check('Home → every "Into archives" link opens its document; the missing one creates nothing', async () => {
  const home = await app.vault.read(file('Home.md'));
  const section = home.split(/^##\s+/m).find((s) => /^Into archives/i.test(s)) ?? '';
  const links = [...section.matchAll(/\[[^\]]*\]\(([^)]+)\)|\[\[([^\]|]+)/g)].map((m) => m[1] ?? m[2]);
  const out = [];
  for (const link of links) {
    await openFile('Home.md');
    const n = fileCount();
    await mainLeaf().openLinkText(link, 'Home.md', false);
    await sleep(800);
    out.push({ link, ...state(), newFiles: fileCount() - n });
  }
  const opened = out.filter((o) => !/nope/.test(o.link));
  return { ok: out.length > 1 && out.every((o) => o.newFiles === 0) && opened.every((o) => o.type === 'mdz-document'), detail: out };
});

await check('Project Alpha → [[Alpha Handbook.mdz]] opens the archive', async () => {
  const note = app.vault.getMarkdownFiles().find((f) => f.basename === 'Project Alpha');
  await openFile(note.path);
  await mainLeaf().openLinkText('Alpha Handbook.mdz', note.path, false);
  await sleep(800);
  return { ok: state().file === 'Projects/Alpha Handbook.mdz', detail: state() };
});

await check('Recipes opens on recipes.md; README and AGENTS are listed', async () => {
  const leaf = await openFile('Recipes.mdz');
  const docs = leaf.view.listDocuments();
  return { ok: state(leaf).doc === 'recipes.md' && docs.includes('README.md') && docs.includes('AGENTS.md'), detail: docs };
});

await check('Café Notes: résumé.md and 笔记/索引.md open', async () => {
  const out = [];
  for (const target of ['résumé.md', '笔记/索引.md']) out.push(await follow('Archives/Café Notes.mdz', null, encodeURI(target)));
  return { ok: out[0].doc === 'résumé.md' && out[1].doc === '笔记/索引.md' && out.every((o) => o.newFiles === 0), detail: out };
});

await check('Turning the plugin off and on keeps the tab and leaves the archive unchanged', async () => {
  const leaf = await openFile('Projects/Alpha Handbook.mdz');
  await leaf.view.openDocument('guide/setup.md');
  await sleep(700);
  const f = file('Projects/Alpha Handbook.mdz');
  const before = { mtime: f.stat.mtime, size: f.stat.size };
  await app.plugins.disablePlugin('mdzip');
  await sleep(1000);
  await app.plugins.enablePlugin('mdzip');
  await sleep(2500);
  const after = { type: leaf.view.getViewType(), doc: leaf.view.getCurrentDocument?.(), mtime: f.stat.mtime, size: f.stat.size };
  return { ok: after.type === 'mdz-document' && after.doc === 'guide/setup.md' && after.mtime === before.mtime && after.size === before.size, detail: { before, after } };
});
