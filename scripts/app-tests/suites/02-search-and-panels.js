// MDZip search, the Archive contents pane's search, and the MDZip links panel. Read-only.

const pane = async () => {
  if (!ws.getLeavesOfType('mdz-contents').length) {
    await app.commands.executeCommandById('mdzip:show-contents');
    await sleep(800);
  }
  return ws.getLeavesOfType('mdz-contents')[0].view;
};
const searchButton = (p) => p.contentEl.querySelector('.nav-action-button[aria-label="Search this archive"], .nav-action-button[aria-label="Hide search"]');
const searchInput = (p) => p.contentEl.querySelector('.mdz-contents-search input');
const type = async (p, text) => {
  const input = searchInput(p);
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => p.contentEl.querySelector('.mdz-contents-text-heading')?.textContent.includes(':') || p.contentEl.textContent.includes('No text matches'), 5000);
};
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const rows = (p) => [...p.contentEl.querySelectorAll('.mdz-contents-tree .tree-item-self')].map((e) => e.dataset.path);

await check('MDZip search finds osprey, pancake and lorem', async () => {
  const out = {};
  for (const q of ['osprey', 'pancake', 'lorem']) out[q] = await plugin.catalog.search(q, () => {}, () => false);
  return { ok: out.osprey > 0 && out.pancake > 0 && out.lorem >= 200, detail: out };
});

await check('MDZip search: a result opens its archive document with the match selected', async () => {
  await openFile('Home.md');
  await app.commands.executeCommandById('mdzip:search-archives');
  await sleep(800);
  const view = ws.getLeavesOfType('mdz-search')[0].view;
  const input = view.contentEl.querySelector('.mdz-search-input');
  input.value = 'osprey';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const hit = await waitFor(() => view.contentEl.querySelector('.mdz-search-match'), 5000);
  hit.click();
  await sleep(1200);
  const v = mainLeaf().view;
  return { ok: v.file?.path === 'Archives/Field Guide.mdz' && v.getCurrentDocument() === 'birds.md' && v.editor.getSelection().toLowerCase() === 'osprey', detail: { ...state(), selection: v.editor.getSelection() } };
});

await check('Contents pane: the search box is hidden until the magnifier is clicked', async () => {
  await openFile('Projects/Alpha Handbook.mdz');
  const p = await pane();
  const hidden = searchInput(p).offsetParent === null;
  searchButton(p).click();
  await sleep(300);
  return { ok: hidden && searchInput(p).offsetParent !== null && document.activeElement === searchInput(p), detail: { hidden } };
});

await check('Contents pane: typing filters names and lists text matches', async () => {
  const p = await pane();
  await type(p, 'setup');
  const names = rows(p);
  const lines = [...p.contentEl.querySelectorAll('.mdz-contents-text .mdz-search-match')].map((e) => e.textContent);
  return { ok: names.includes('guide/setup.md') && !names.includes('reference/api.md') && lines.length === 3, detail: { names, lines } };
});

await check('Contents pane: clicking a match opens its document at that line', async () => {
  const p = await pane();
  const match = [...p.contentEl.querySelectorAll('.mdz-contents-text .mdz-search-match')].find((e) => e.textContent.startsWith('# Setup'));
  match.click();
  await sleep(1000);
  const v = mainLeaf().view;
  return { ok: v.getCurrentDocument() === 'guide/setup.md' && v.editor.getCursor().line === 0 && v.editor.getSelection() === 'Setup', detail: { doc: v.getCurrentDocument(), selection: v.editor.getSelection() } };
});

await check('Contents pane: no matches says so', async () => {
  const p = await pane();
  await type(p, 'zzqqxx');
  const notes = [...p.contentEl.querySelectorAll('.mdz-contents-note')].map((e) => e.textContent);
  return { ok: notes.includes('No file names match.') && notes.includes('No text matches.'), detail: notes };
});

await check('Contents pane: Enter opens the first matching document', async () => {
  const p = await pane();
  await type(p, 'api');
  key(searchInput(p), 'Enter');
  const opened = await waitFor(() => mainLeaf().view.getCurrentDocument() === 'reference/api.md', 5000);
  return { ok: !!opened, detail: mainLeaf().view.getCurrentDocument() };
});

await check('Contents pane: Esc clears, Esc again hides, the tree comes back', async () => {
  const p = await pane();
  const input = searchInput(p);
  key(input, 'Escape');
  await waitFor(() => input.value === '', 3000);
  const first = { value: input.value, visible: input.offsetParent !== null };
  key(input, 'Escape');
  await waitFor(() => input.offsetParent === null && rows(p).includes('reference/api.md'), 3000);
  const second = { visible: input.offsetParent !== null, rows: rows(p).length };
  return { ok: first.value === '' && first.visible && !second.visible && rows(p).includes('reference/api.md'), detail: { first, second } };
});

await check('Contents pane: searching 200 documents takes under a second', async () => {
  await openFile('Archives/Library.mdz');
  const p = await pane();
  searchButton(p).click();
  await sleep(200);
  const t0 = performance.now();
  await type(p, 'lorem');
  const ms = Math.round(performance.now() - t0);
  const heading = p.contentEl.querySelector('.mdz-contents-text-heading')?.textContent;
  return { ok: heading === 'In documents: 200 lines' && ms < 1000, detail: { heading, ms } };
});

await check('Contents pane: a search is cleared when another archive is shown, kept across a note', async () => {
  const p = await pane();
  await openFile('Home.md');
  await openFile('Archives/Library.mdz');
  const kept = searchInput(p).value;
  await openFile('Recipes.mdz');
  const cleared = { value: searchInput(p).value, visible: searchInput(p).offsetParent !== null, rows: rows(p).length };
  return { ok: kept === 'lorem' && cleared.value === '' && !cleared.visible && cleared.rows > 3, detail: { kept, cleared } };
});

await check('Links panel on the Field Guide: linked from, links to, not found', async () => {
  await openFile('Archives/Field Guide.mdz');
  await app.commands.executeCommandById('mdzip:show-links');
  await sleep(1500);
  const text = ws.getLeavesOfType('mdz-links')[0]?.view.contentEl.innerText ?? '';
  return { ok: /LINKED FROM/i.test(text) && /LINKS TO/i.test(text) && /NOT FOUND[\s\S]*Missing\.md/i.test(text), detail: text.slice(0, 500) };
});

await check('Links panel on Ada Lovelace: "Linked from archives" lists the Field Guide', async () => {
  await openFile('People/Ada Lovelace.md');
  await sleep(1500);
  const text = ws.getLeavesOfType('mdz-links')[0]?.view.contentEl.innerText ?? '';
  return { ok: /LINKED FROM ARCHIVES[\s\S]*Field Guide\.mdz/i.test(text), detail: text.slice(0, 400) };
});
