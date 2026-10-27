// Images: pasting into an archive document, and converting a note to .mdz
// when an image is pasted into it. Runs on scratch copies.

const isZip = async (path) => {
  const head = new Uint8Array(await app.vault.adapter.readBinary(path));
  return head[0] === 0x50 && head[1] === 0x4b;
};

await check('An image pasted into an archive document is stored in images/', async () => {
  const copy = await copyArchive('Projects/Alpha Handbook.mdz', 'Paste Target.mdz');
  const leaf = await openFile(copy);
  const before = leaf.view.listArchiveEntries().map((e) => e.path);
  await pasteImage(leaf.view);
  await sleep(1200);
  // With "Ask each time" for the image format, answer the Insert image dialog.
  if (lastModal()) clickButton(lastModal(), 'Insert');
  await sleep(2500);
  const added = leaf.view.listArchiveEntries().map((e) => e.path).filter((p) => !before.includes(p));
  const text = leaf.view.editor.getValue();
  return { ok: added.length === 1 && /^images\/pasted-\d+\.png$/.test(added[0]) && text.includes(added[0]), detail: { added, tail: text.slice(-60) } };
});

await check('The convert dialog names the folder "Paste normally" saves to, and it saves there', async () => {
  const dir = await scratch();
  const out = [];
  for (const [setting, expected] of [['Attachments', 'Attachments'], ['./', dir]]) {
    setConfig('attachmentFolderPath', setting);
    const md = `${dir}/Normal ${out.length}.md`;
    await app.vault.create(md, '# Normal\n');
    await sleep(500);
    const leaf = await openFile(md);
    const before = new Set(app.vault.getFiles().map((f) => f.path));
    await pasteImage(leaf.view);
    const dialog = await waitFor(() => (/Convert this note/.test(lastModal()?.textContent ?? '') ? lastModal() : null), 3000);
    const said = [...dialog.querySelectorAll('p')].map((p) => p.textContent).find((t) => t.startsWith('Paste normally'));
    clickButton(dialog, 'Paste normally');
    const saved = await waitFor(() => app.vault.getFiles().find((f) => !before.has(f.path) && /^Pasted image/.test(f.name)), 5000);
    const savedIn = saved?.parent?.path;
    out.push({ setting, said, savedIn, linked: leaf.view.editor.getValue().includes(saved?.name ?? '?') });
    if (saved) await app.vault.delete(saved); // Attachments/ isn't scratch: remove it ourselves
    if (!(said ?? '').includes(` ${expected}/`) || savedIn !== expected) return { ok: false, detail: out };
  }
  return { ok: out.every((o) => o.linked), detail: out };
});

/** Paste into a new note, answer Convert, and (if Obsidian asks) its "Update links" question. */
const convert = async (name, alwaysUpdate) => {
  setConfig('alwaysUpdateLinks', alwaysUpdate);
  const dir = await scratch();
  const md = `${dir}/${name}.md`;
  await app.vault.create(md, `# ${name}\n\n![photo](../Attachments/photo.png)\n`);
  await app.vault.create(`${dir}/Points at ${name}.md`, `[target](${encodeURI(name)}.md)\n[[${name}]]\n`);
  await sleep(1500);
  const leaf = await openFile(md);
  await pasteImage(leaf.view);
  const dialog = await waitFor(() => (/Convert this note/.test(lastModal()?.textContent ?? '') ? lastModal() : null), 3000);
  clickButton(dialog, 'Convert');
  const mdz = `${dir}/${name}.mdz`;
  let prompt = null;
  if (!alwaysUpdate) {
    const asked = await waitFor(() => modals().find((m) => /Update links/.test(m.innerText)), 5000);
    // The fix: the archive is already written while Obsidian waits for an answer.
    prompt = { asked: !!asked, zipWhileAsking: !!file(mdz) && (await isZip(mdz)), viewWhileAsking: leaf.view.getViewType() };
    clickButton(asked?.querySelector('.modal'), 'Just once');
  }
  await waitFor(() => leaf.view.getViewType() === 'mdz-document', 5000);
  await sleep(1000);
  return {
    prompt,
    md: !!file(md),
    zip: !!file(mdz) && (await isZip(mdz)),
    view: leaf.view.getViewType(),
    entries: leaf.view.listArchiveEntries?.().map((e) => e.path),
    text: leaf.view.editor?.getValue(),
    pointer: await app.vault.read(file(`${dir}/Points at ${name}.md`)),
  };
};

await check('Convert on paste ("Update links" asked): archive written before the answer, links updated', async () => {
  const r = await convert('Ask First', false);
  return {
    ok:
      r.prompt?.asked && r.prompt.zipWhileAsking && !r.md && r.zip && r.view === 'mdz-document' &&
      r.entries.includes('images/photo.png') && r.entries.some((p) => /^images\/pasted-/.test(p)) &&
      r.text.includes('](images/photo.png)') && r.pointer.includes('Ask%20First.mdz') && r.pointer.includes('[[Ask First.mdz]]'),
    detail: r,
  };
});

await check('Convert on paste (links updated automatically)', async () => {
  const r = await convert('Auto Links', true);
  return { ok: !r.md && r.zip && r.view === 'mdz-document' && r.pointer.includes('Auto%20Links.mdz'), detail: r };
});
