// Renaming or moving an archive keeps links from notes into its documents
// working (links to the archive itself are Obsidian's). Runs on scratch copies.

const setup = async (name) => {
  const dir = await scratch();
  const archive = await copyArchive('Projects/Alpha Handbook.mdz', `${name}.mdz`);
  const enc = encodeURIComponent(name);
  const note = `${dir}/Links to ${name}.md`;
  await app.vault.create(
    note,
    [
      `[relative](${enc}.mdz/guide/advanced.md#Tuning)`,
      `[absolute](/${dir}/${enc}.mdz/reference/api.md)`,
      `[[${name}.mdz/guide/setup|Setup]]`,
      `[whole](${enc}.mdz)`,
      '',
    ].join('\n')
  );
  // A note elsewhere, linking by the archive's name.
  await app.vault.create(`${dir}/Sub/By name ${name}.md`, `[by name](${enc}.mdz/index.md)\n`).catch(async () => {
    await app.vault.createFolder(`${dir}/Sub`);
    await app.vault.create(`${dir}/Sub/By name ${name}.md`, `[by name](${enc}.mdz/index.md)\n`);
  });
  await sleep(2000);
  return { archive, note, byName: `${dir}/Sub/By name ${name}.md` };
};
/** Every link in the note opens the document it should. */
const opens = async (notePath, expect) => {
  const out = [];
  for (const [link, doc] of expect) {
    await openFile(notePath);
    await mainLeaf().openLinkText(link, notePath, false);
    await sleep(800);
    out.push({ link, ...state() });
    if (state().doc !== doc) return { ok: false, out };
  }
  return { ok: true, out };
};

await check('Rename with automatic link updates: every link form follows', async () => {
  setConfig('alwaysUpdateLinks', true);
  const s = await setup('Rename Auto');
  await app.fileManager.renameFile(file(s.archive), `${SCRATCH}/Renamed Auto.mdz`);
  await waitFor(() => notices().some((n) => /Updated \d+ links? into Renamed Auto\.mdz/.test(n)), 6000);
  await sleep(500);
  const note = await app.vault.read(file(s.note));
  const byName = await app.vault.read(file(s.byName));
  const expected = [
    '[relative](Renamed%20Auto.mdz/guide/advanced.md#Tuning)',
    `[absolute](/${SCRATCH}/Renamed%20Auto.mdz/reference/api.md)`,
    '[[Renamed Auto.mdz/guide/setup|Setup]]',
    '[whole](Renamed%20Auto.mdz)',
  ];
  const ok = expected.every((l) => note.includes(l)) && byName.includes('[by name](Renamed%20Auto.mdz/index.md)');
  return { ok, detail: { note, byName, notices: notices() } };
});

await check('Rename with link updates off: asks, then updates', async () => {
  setConfig('alwaysUpdateLinks', false);
  const s = await setup('Rename Ask');
  const renaming = app.fileManager.renameFile(file(s.archive), `${SCRATCH}/Renamed Ask.mdz`);
  // Obsidian asks first (for [whole]), then MDZip asks for the links into the archive.
  const obsidians = await waitFor(() => modals().find((m) => /Do you want to update internal links/.test(m.innerText)), 5000);
  clickButton(obsidians?.querySelector('.modal'), 'Just once');
  await renaming;
  const ours = await waitFor(() => modals().find((m) => /Update links into the archive/.test(m.innerText)), 5000);
  const text = ours?.innerText;
  clickButton(ours?.querySelector('.modal'), 'Update');
  await sleep(1500);
  const note = await app.vault.read(file(s.note));
  return { ok: !!obsidians && /3 links in 1 note|4 links in 2 notes/.test(text ?? '') && note.includes('[relative](Renamed%20Ask.mdz/guide/advanced.md#Tuning)') && note.includes('[whole](Renamed%20Ask.mdz)'), detail: { asked: text, note } };
});

await check('Rename with link updates off, answered "Do not update": links left alone', async () => {
  setConfig('alwaysUpdateLinks', false);
  const s = await setup('Rename No');
  const renaming = app.fileManager.renameFile(file(s.archive), `${SCRATCH}/Renamed No.mdz`);
  const obsidians = await waitFor(() => modals().find((m) => /Do you want to update internal links/.test(m.innerText)), 5000);
  clickButton(obsidians?.querySelector('.modal'), 'Do not update');
  await renaming;
  const ours = await waitFor(() => modals().find((m) => /Update links into the archive/.test(m.innerText)), 5000);
  clickButton(ours?.querySelector('.modal'), 'Do not update');
  await sleep(1000);
  const note = await app.vault.read(file(s.note));
  return { ok: !!ours && note.includes('[relative](Rename%20No.mdz/guide/advanced.md#Tuning)'), detail: note };
});

await check('Moving an archive to another folder updates relative links; the moved links open', async () => {
  setConfig('alwaysUpdateLinks', true);
  const s = await setup('Move Me');
  await app.vault.createFolder(`${SCRATCH}/Elsewhere`);
  await app.fileManager.renameFile(file(s.archive), `${SCRATCH}/Elsewhere/Move Me.mdz`);
  await waitFor(() => notices().some((n) => /into Move Me\.mdz/.test(n)), 6000);
  await sleep(500);
  const note = await app.vault.read(file(s.note));
  const nav = await opens(s.note, [
    ['Elsewhere/Move%20Me.mdz/guide/advanced.md', 'guide/advanced.md'],
    [`/${SCRATCH}/Elsewhere/Move%20Me.mdz/reference/api.md`, 'reference/api.md'],
  ]);
  return { ok: note.includes('[relative](Elsewhere/Move%20Me.mdz/guide/advanced.md#Tuning)') && nav.ok, detail: { note, nav } };
});
