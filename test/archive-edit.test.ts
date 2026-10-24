import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { MdzArchiveCore } from '@mdzip/core-js';
import {
  applyEntryPoint,
  applyMoves,
  applyNewFolder,
  applyRemove,
  foldersOf,
  linksInto,
  listingOf,
  newFolderPath,
  planMove,
  planRemove,
  removeProblem,
  type Listing,
} from '../src/archive-edit.ts';

const facts = { entryPoint: 'index.md', mode: 'project' as const };

function archive(files: Record<string, string>, manifest?: object): ArrayBuffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = path.endsWith('/') ? new Uint8Array() : strToU8(text);
  if (manifest) entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  const bytes = zipSync(entries);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function open(bytes: ArrayBuffer) {
  return MdzArchiveCore.open(new Uint8Array(bytes));
}

async function text(bytes: ArrayBuffer, path: string): Promise<string | null> {
  const entry = (await open(bytes)).findEntry(path) as { async(k: 'text'): Promise<string> } | null;
  return entry ? entry.async('text') : null;
}

const listing: Listing = {
  files: ['index.md', 'docs/guide.md', 'docs/img/a.png', 'notes'],
  dirs: ['empty/', 'docs/'],
};

test('folders come from directory entries and file paths', () => {
  assert.deepEqual(foldersOf(listing), ['docs', 'docs/img', 'empty']);
});

test('new folder paths are checked', () => {
  assert.deepEqual(newFolderPath(' /drafts/ ', listing), { path: 'drafts' });
  assert.match((newFolderPath('Docs', listing) as { error: string }).error, /already exists/);
  assert.match((newFolderPath('notes/x', listing) as { error: string }).error, /is a file/);
  assert.ok('error' in newFolderPath('../up', listing));
});

test('planning a move: files keep their extension; folders bring everything in them', () => {
  const file = planMove(listing, 'docs/guide.md', 'guide', false);
  assert.deepEqual(file, { target: 'guide.md', moves: new Map([['docs/guide.md', 'guide.md']]) });
  const folder = planMove(listing, 'docs', 'manual/docs', true);
  assert.ok(!('error' in folder));
  assert.deepEqual(
    [...folder.moves],
    [
      ['docs/guide.md', 'manual/docs/guide.md'],
      ['docs/img/a.png', 'manual/docs/img/a.png'],
      ['docs/', 'manual/docs/'],
    ]
  );
});

test('planning a move refuses collisions, moving a folder into itself, and the manifest', () => {
  assert.match((planMove(listing, 'docs/guide.md', 'INDEX.md', false) as { error: string }).error, /already/);
  assert.match((planMove(listing, 'docs', 'docs/inner', true) as { error: string }).error, /into itself/);
  assert.match((planMove(listing, 'docs', 'empty', true) as { error: string }).error, /already exists/);
  assert.ok('error' in planMove(listing, 'docs/guide.md', 'docs/guide.md', false));
  assert.ok('error' in planMove({ files: ['manifest.json'], dirs: [] }, 'manifest.json', 'm.json', false));
  // Changing only the case of its own name is fine.
  assert.ok(!('error' in planMove(listing, 'docs/guide.md', 'docs/Guide.md', false)));
});

test('planning a removal, and what may not be removed', () => {
  assert.deepEqual(planRemove(listing, 'docs', true), ['docs/guide.md', 'docs/img/a.png', 'docs/']);
  assert.deepEqual(planRemove(listing, 'notes', false), ['notes']);
  assert.match(removeProblem(['index.md'], facts)!, /entry point/);
  assert.match(removeProblem(['manifest.json'], facts)!, /manifest/);
});

test('moving a document updates links to it and its own links, and keeps other bytes', async () => {
  const bytes = archive(
    {
      'index.md': '# Home\n\n[Guide](docs/guide.md) ![](docs/img/a.png)\n',
      'docs/guide.md': '[home](../index.md) ![](img/a.png)\n',
      'docs/img/a.png': 'PNG',
    },
    { entryPoint: 'index.md', mode: 'project', title: 'T', custom: { keep: true } }
  );
  const result = await applyMoves(bytes, new Map([['docs/guide.md', 'guide.md']]), facts);
  assert.deepEqual(result.rewritten.sort(), ['guide.md', 'index.md']);
  assert.equal(await text(result.bytes, 'index.md'), '# Home\n\n[Guide](guide.md) ![](docs/img/a.png)\n');
  assert.equal(await text(result.bytes, 'guide.md'), '[home](index.md) ![](docs/img/a.png)\n');
  assert.equal(await text(result.bytes, 'docs/guide.md'), null);
  assert.equal(await text(result.bytes, 'docs/img/a.png'), 'PNG');
  const manifest = JSON.parse((await text(result.bytes, 'manifest.json'))!);
  assert.deepEqual(manifest.custom, { keep: true });
});

test('moving the entry point and the cover updates the manifest', async () => {
  const bytes = archive({ 'index.md': '![](cover.png)', 'cover.png': 'PNG' }, { entryPoint: 'index.md', cover: 'cover.png' });
  const moves = new Map([
    ['index.md', 'docs/start.md'],
    ['cover.png', 'img/cover.png'],
  ]);
  const result = await applyMoves(bytes, moves, facts);
  const opened = await open(result.bytes);
  assert.equal(await opened.resolveEntryPoint(), 'docs/start.md');
  assert.equal(JSON.parse((await text(result.bytes, 'manifest.json'))!).cover, 'img/cover.png');
  assert.equal(await text(result.bytes, 'docs/start.md'), '![](../img/cover.png)');
});

test('moving a folder, including an empty one inside it', async () => {
  const bytes = archive({ 'index.md': '[a](docs/a.md)', 'docs/a.md': 'A', 'docs/empty/': '' });
  const plan = planMove(listingOf(await open(bytes)), 'docs', 'manual', true);
  assert.ok(!('error' in plan));
  const result = await applyMoves(bytes, plan.moves, facts);
  const moved = listingOf(await open(result.bytes));
  assert.deepEqual(moved.files.sort(), ['index.md', 'manifest.json', 'manual/a.md']);
  assert.deepEqual(moved.dirs, ['manual/empty/']);
  assert.equal(await text(result.bytes, 'index.md'), '[a](manual/a.md)');
});

test('an archive without a manifest gets one when a move would change its entry point', async () => {
  const bytes = archive({ 'notes.md': 'N', 'other/x.png': 'PNG' });
  const result = await applyMoves(bytes, new Map([['notes.md', 'docs/notes.md']]), { entryPoint: 'notes.md', mode: 'document' });
  assert.equal(await (await open(result.bytes)).resolveEntryPoint(), 'docs/notes.md');
});

test('removing files and folders; links into them are found first; a removed cover is cleared', async () => {
  const bytes = archive(
    { 'index.md': '![](img/c.png) [[draft]]', 'img/c.png': 'PNG', 'drafts/draft.md': 'D', 'drafts/old/': '' },
    { entryPoint: 'index.md', cover: 'img/c.png' }
  );
  const opened = await open(bytes);
  assert.deepEqual(await linksInto(opened, ['img/c.png']), ['index.md']);
  const removed = planRemove(listingOf(opened), 'drafts', true);
  assert.deepEqual(await linksInto(opened, removed), ['index.md']);

  const afterFolder = await applyRemove(bytes, removed, facts);
  const after = listingOf(await open(afterFolder));
  assert.deepEqual(after.files.sort(), ['img/c.png', 'index.md', 'manifest.json']);
  assert.deepEqual(after.dirs, []);

  const afterCover = await applyRemove(afterFolder, ['img/c.png'], facts);
  assert.equal(JSON.parse((await text(afterCover, 'manifest.json'))!).cover, undefined);
  await assert.rejects(() => applyRemove(bytes, ['index.md'], facts), /entry point/);
});

test('new folders and a new entry point', async () => {
  const bytes = archive({ 'index.md': 'I', 'b.md': 'B' }, { entryPoint: 'index.md' });
  const withFolder = await applyNewFolder(bytes, 'drafts/2026');
  assert.deepEqual(listingOf(await open(withFolder)).dirs, ['drafts/2026/']);
  const moved = await applyEntryPoint(withFolder, 'b.md', facts);
  assert.equal(await (await open(moved)).resolveEntryPoint(), 'b.md');
});
