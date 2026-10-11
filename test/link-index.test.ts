import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkIndex } from '../src/link-index.ts';
import type { ArchiveSummary } from '../src/archive-catalog.ts';

const project: ArchiveSummary = {
  path: 'MyVault/Project.mdz',
  entryPoint: 'index.md',
  docs: ['index.md', 'chapters/intro.md'],
  links: new Map([
    ['index.md', ['MyVault/Notes.md', 'MyVault/Project.mdz/chapters/intro.md']],
    ['chapters/intro.md', ['MyVault/Project.mdz', 'MyVault/Other.mdz/guide.md']],
  ]),
  unresolved: new Map([['index.md', ['../Missing.md']]]),
};
const other: ArchiveSummary = {
  path: 'MyVault/Other.mdz',
  entryPoint: 'index.md',
  docs: ['index.md', 'guide.md'],
  links: new Map(),
  unresolved: new Map(),
};
const noteLinks = new Map([
  ['MyVault/Linker.md', [{ target: 'MyVault/Project.mdz/chapters/intro.md', unresolvedId: 'Project.mdz/chapters/intro' }]],
]);
const resolvedLinks = { 'MyVault/Index.md': { 'MyVault/Project.mdz': 1, 'MyVault/Notes.md': 1 } };
const index = buildLinkIndex([project, other], noteLinks, resolvedLinks);

test('entry document: incoming from archive documents and from notes linking the .mdz', () => {
  assert.deepEqual(index.incoming('MyVault/Project.mdz'), ['MyVault/Index.md', 'MyVault/Project.mdz/chapters/intro.md']);
  assert.deepEqual(index.outgoing('MyVault/Project.mdz'), ['MyVault/Notes.md', 'MyVault/Project.mdz/chapters/intro.md']);
  assert.deepEqual(index.unresolved('MyVault/Project.mdz'), ['../Missing.md']);
});

test('other documents: incoming from notes, outgoing into other archives', () => {
  assert.deepEqual(index.incoming('MyVault/Project.mdz/chapters/intro.md'), ['MyVault/Linker.md', 'MyVault/Project.mdz']);
  assert.deepEqual(index.outgoing('MyVault/Project.mdz/chapters/intro.md'), ['MyVault/Other.mdz/guide.md', 'MyVault/Project.mdz']);
});

test('a vault note sees archive documents that link to it', () => {
  assert.deepEqual(index.incoming('MyVault/Notes.md'), ['MyVault/Project.mdz']);
});

test('locate maps node ids back to archive documents', () => {
  assert.deepEqual(index.locate('MyVault/Project.mdz'), { archive: 'MyVault/Project.mdz', doc: 'index.md' });
  assert.deepEqual(index.locate('MyVault/Other.mdz/guide.md'), { archive: 'MyVault/Other.mdz', doc: 'guide.md' });
  assert.equal(index.locate('MyVault/Notes.md'), null);
});

test('note-to-note links from resolvedLinks are not included', () => {
  assert.deepEqual(index.outgoing('MyVault/Index.md'), ['MyVault/Project.mdz']);
});
