import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkSpans, linkedEntries, relativePath, resolveRef, rewriteLinks } from '../src/link-rewrite.ts';

const files = ['index.md', 'docs/guide.md', 'docs/setup.md', 'images/logo.png', 'docs/images/shot.png', 'My Notes.md'];

/** Rewrite `markdown`, written in `doc`, after the given moves. */
function after(markdown: string, doc: string, moves: Record<string, string>): string {
  const map = new Map(Object.entries(moves));
  return rewriteLinks(markdown, {
    from: doc,
    to: map.get(doc) ?? doc,
    moves: map,
    before: { files },
    after: { files: files.map((f) => map.get(f) ?? f) },
  });
}

test('finds link destinations in every syntax, skipping code', () => {
  const md = [
    '[a](docs/guide.md "title") ![b](<images/logo.png>)',
    '[[setup#Install|alias]] ![[shot.png]]',
    '[ref]: docs/setup.md',
    '<a href="docs/guide.md">x</a> <img src=\'images/logo.png\'>',
    '`[no](inline.md)`',
    '```',
    '[no](fenced.md)',
    '```',
  ].join('\n');
  const dests = findLinkSpans(md).map((s) => md.slice(s.start, s.end));
  assert.deepEqual(dests, [
    'docs/guide.md',
    'images/logo.png',
    'setup#Install',
    'shot.png',
    'docs/setup.md',
    'docs/guide.md',
    'images/logo.png',
  ]);
});

test('resolves like the view: path, then .md, then document name; outside the archive', () => {
  const index = { files };
  assert.deepEqual(resolveRef('docs/guide.md', 'setup.md', index), { kind: 'entry', path: 'docs/setup.md' });
  assert.deepEqual(resolveRef('docs/guide.md', 'setup', index), { kind: 'entry', path: 'docs/setup.md' });
  assert.deepEqual(resolveRef('index.md', 'setup', index), { kind: 'entry', path: 'docs/setup.md' });
  assert.deepEqual(resolveRef('docs/guide.md', '../../Notes.md', index), { kind: 'outside', path: '../Notes.md' });
  assert.equal(resolveRef('index.md', 'missing.md', index), null);
});

test('links to a moved file follow it', () => {
  assert.equal(
    after('See [setup](docs/setup.md#install) and ![](images/logo.png).', 'index.md', {
      'docs/setup.md': 'guides/install.md',
      'images/logo.png': 'assets/logo.png',
    }),
    'See [setup](guides/install.md#install) and ![](assets/logo.png).'
  );
});

test("a moved document's own relative links are re-based", () => {
  assert.equal(
    after('[s](setup.md) ![](images/shot.png) [home](../index.md)', 'docs/guide.md', { 'docs/guide.md': 'guide.md' }),
    '[s](docs/setup.md) ![](docs/images/shot.png) [home](index.md)'
  );
});

test('links that leave the archive keep pointing at the same file', () => {
  assert.equal(after('[n](../Notes.md)', 'index.md', { 'index.md': 'a/b/index.md' }), '[n](../../../Notes.md)');
  assert.equal(after('[n](../../Notes.md)', 'docs/guide.md', { 'docs/guide.md': 'guide.md' }), '[n](../Notes.md)');
});

test('bare wikilinks stay bare while the name still finds the file', () => {
  assert.equal(after('[[setup]] [[setup#Install|Install]]', 'index.md', { 'docs/setup.md': 'other/setup.md' }), '[[setup]] [[setup#Install|Install]]');
  assert.equal(after('[[setup|Setup]]', 'index.md', { 'docs/setup.md': 'docs/install.md' }), '[[install|Setup]]');
  assert.equal(after('![[images/logo.png]]', 'index.md', { 'images/logo.png': 'assets/logo.png' }), '![[assets/logo.png]]');
  // Only documents are found by name inside an archive, so this didn't resolve and is left alone.
  assert.equal(after('![[logo.png]]', 'index.md', { 'images/logo.png': 'assets/logo.png' }), '![[logo.png]]');
});

test('Markdown links that resolve by path keep doing so; ones that relied on name lookup may keep relying on it', () => {
  assert.equal(after('[s](setup.md)', 'docs/guide.md', { 'docs/guide.md': 'guide.md' }), '[s](docs/setup.md)');
  assert.equal(after('[s](setup)', 'index.md', { 'index.md': 'a/index.md' }), '[s](setup)');
});

test('extensionless links stay extensionless', () => {
  assert.equal(after('[s](docs/setup)', 'index.md', { 'docs/setup.md': 'setup.md' }), '[s](setup)');
});

test('names with spaces: percent-encoded in Markdown links, as-is in angle brackets and wikilinks', () => {
  assert.equal(after('[n](My%20Notes.md)', 'index.md', { 'My Notes.md': 'docs/My Notes.md' }), '[n](docs/My%20Notes.md)');
  assert.equal(after('[n](<My Notes.md>)', 'index.md', { 'My Notes.md': 'docs/My Notes.md' }), '[n](<docs/My Notes.md>)');
  assert.equal(after('[[My Notes]]', 'docs/guide.md', { 'My Notes.md': 'old/My Notes.md' }), '[[My Notes]]');
});

test('HTML and reference links are rewritten; unresolved, external and code links are not', () => {
  const md = '<img src="images/logo.png">\n[r]: images/logo.png\n[x](missing.md) [w](https://x.org/images/logo.png) `![](images/logo.png)`';
  assert.equal(
    after(md, 'index.md', { 'images/logo.png': 'img/logo.png' }),
    '<img src="img/logo.png">\n[r]: img/logo.png\n[x](missing.md) [w](https://x.org/images/logo.png) `![](images/logo.png)`'
  );
});

test('unchanged text comes back as the same string', () => {
  const md = '[a](docs/guide.md)';
  assert.equal(after(md, 'index.md', { 'images/logo.png': 'x.png' }), md);
});

test('linked entries and relative paths', () => {
  assert.deepEqual(linkedEntries('[a](docs/guide.md) [[setup]] [b](nope.md)', 'index.md', { files }).sort(), [
    'docs/guide.md',
    'docs/setup.md',
  ]);
  assert.equal(relativePath('docs/a', 'docs/b/x.md'), '../b/x.md');
  assert.equal(relativePath('', 'x.md'), 'x.md');
});
