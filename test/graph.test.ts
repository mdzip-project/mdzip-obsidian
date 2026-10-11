import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addArchivesToGraph, type GraphData, type GraphOptions } from '../src/graph.ts';
import type { ArchiveSummary } from '../src/archive-catalog.ts';

// Vault: Notes.md, Linker.md (links to Project.mdz/chapters/intro.md), Project.mdz
// (index.md -> ../Notes.md and chapters/intro.md; chapters/intro.md -> index.md).
const project: ArchiveSummary = {
  path: 'MyVault/Project.mdz',
  entryPoint: 'index.md',
  docs: ['index.md', 'chapters/intro.md'],
  links: new Map([
    ['index.md', ['MyVault/Notes.md', 'MyVault/Project.mdz/chapters/intro.md']],
    ['chapters/intro.md', ['MyVault/Project.mdz']],
  ]),
  unresolved: new Map(),
};
const noteLinks = new Map([
  ['MyVault/Linker.md', [{ target: 'MyVault/Project.mdz/chapters/intro.md', unresolvedId: 'Project.mdz/chapters/intro' }]],
]);
const obsidianData = (): GraphData => ({
  nodes: {
    'MyVault/Notes.md': { type: '', links: {} },
    'MyVault/Linker.md': { type: '', links: { 'Project.mdz/chapters/intro': true } },
    'Project.mdz/chapters/intro': { type: 'unresolved', links: {} },
  },
});
const opts = (o: Partial<GraphOptions> = {}): GraphOptions => ({
  showOrphans: true,
  hideUnresolved: false,
  localFile: null,
  localJumps: 1,
  localForelinks: true,
  localBacklinks: true,
  ...o,
});
const input = (focus: string | null = null) => ({
  summaries: [project],
  noteLinks,
  resolvedLinks: { 'MyVault/Linker.md': {}, 'MyVault/Notes.md': {} },
  focus,
  filtered: false,
});
const edges = (d: GraphData) =>
  Object.entries(d.nodes).flatMap(([from, n]) => Object.keys(n.links).map((to) => `${from} -> ${to}`)).sort();

test('global graph gains archive documents and their links', () => {
  const d = addArchivesToGraph(obsidianData(), opts(), input());
  assert.deepEqual(Object.keys(d.nodes).sort(), [
    'MyVault/Linker.md',
    'MyVault/Notes.md',
    'MyVault/Project.mdz',
    'MyVault/Project.mdz/chapters/intro.md',
  ]);
  assert.deepEqual(edges(d), [
    'MyVault/Linker.md -> MyVault/Project.mdz/chapters/intro.md',
    'MyVault/Project.mdz -> MyVault/Notes.md',
    'MyVault/Project.mdz -> MyVault/Project.mdz/chapters/intro.md',
    'MyVault/Project.mdz/chapters/intro.md -> MyVault/Project.mdz',
  ]);
});

test('unresolved stand-ins for links into archives are removed', () => {
  const d = addArchivesToGraph(obsidianData(), opts(), input());
  assert.equal(d.nodes['Project.mdz/chapters/intro'], undefined);
});

test('focus moves to the open archive document', () => {
  const d = addArchivesToGraph(obsidianData(), opts(), input('MyVault/Project.mdz/chapters/intro.md'));
  assert.equal(d.nodes['MyVault/Project.mdz/chapters/intro.md'].type, 'focused');
});

test('local graph of a note adds only nearby archive documents', () => {
  const local: GraphData = { nodes: { 'MyVault/Notes.md': { type: 'focused', links: {} } } };
  const d = addArchivesToGraph(local, opts({ localFile: 'MyVault/Notes.md' }), input());
  // Notes.md is linked from the archive's entry document only.
  assert.deepEqual(Object.keys(d.nodes).sort(), ['MyVault/Notes.md', 'MyVault/Project.mdz']);
});

test('local graph of an archive centres on the focused document', () => {
  const d = addArchivesToGraph({ nodes: {} }, opts({ localFile: 'MyVault/Project.mdz' }), input('MyVault/Project.mdz/chapters/intro.md'));
  assert.deepEqual(Object.keys(d.nodes).sort(), [
    'MyVault/Linker.md',
    'MyVault/Project.mdz',
    'MyVault/Project.mdz/chapters/intro.md',
  ]);
  assert.equal(d.nodes['MyVault/Project.mdz/chapters/intro.md'].type, 'focused');
});

test('archive nodes are left out while the graph has a search filter', () => {
  const d = addArchivesToGraph(obsidianData(), opts(), { ...input(), filtered: true });
  assert.equal(d.nodes['MyVault/Project.mdz'], undefined);
});

test('orphan archive documents are hidden when orphans are off', () => {
  const lonely: ArchiveSummary = { path: 'Lonely.mdz', entryPoint: 'index.md', docs: ['index.md'], links: new Map(), unresolved: new Map() };
  const d = addArchivesToGraph({ nodes: {} }, opts({ showOrphans: false }), { ...input(), summaries: [lonely], noteLinks: new Map() });
  assert.equal(d.nodes['Lonely.mdz'], undefined);
});
