import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLinksIntoArchive } from '../src/note-links.ts';

const rename = (from: string, to: string, others: string[] = []) => ({ from, to, others });

test('relative Markdown links follow a rename, keeping encoding and fragments', () => {
  const note = '[a](Handbook%20Copy.mdz/guide/advanced.md#Tuning) and [b](Handbook%20Copy.mdz)';
  const r = rewriteLinksIntoArchive(note, 'Scratch/Linker.md', rename('Scratch/Handbook Copy.mdz', 'Scratch/Moved Copy.mdz'));
  // The link to the archive itself is Obsidian's to update.
  assert.equal(r.text, '[a](Moved%20Copy.mdz/guide/advanced.md#Tuning) and [b](Handbook%20Copy.mdz)');
  assert.equal(r.count, 1);
});

test('relative links follow a move to another folder', () => {
  const r = rewriteLinksIntoArchive('[x](../Projects/Alpha.mdz/docs/x.md)', 'Notes/n.md', rename('Projects/Alpha.mdz', 'Archive/2026/Alpha.mdz'));
  assert.equal(r.text, '[x](../Archive/2026/Alpha.mdz/docs/x.md)');
});

test('vault-absolute links stay vault-absolute', () => {
  const r = rewriteLinksIntoArchive('[x](/Projects/Alpha.mdz/a.md) [y](Projects/Alpha.mdz/b.md)', 'Daily/d.md', rename('Projects/Alpha.mdz', 'Old/Alpha.mdz'));
  assert.equal(r.text, '[x](/Old/Alpha.mdz/a.md) [y](Old/Alpha.mdz/b.md)');
  assert.equal(r.count, 2);
});

test('name-only links and wikilinks use the new shortest name', () => {
  const note = '[[Alpha.mdz/guide/setup|Setup]] and ![[Alpha.mdz/images/logo.png]] and [s](Alpha.mdz/guide/setup.md)';
  const r = rewriteLinksIntoArchive(note, 'Home.md', rename('Projects/Alpha.mdz', 'Projects/Beta Handbook.mdz', ['Archives/Other.mdz']));
  assert.equal(
    r.text,
    '[[Beta Handbook.mdz/guide/setup|Setup]] and ![[Beta Handbook.mdz/images/logo.png]] and [s](Beta%20Handbook.mdz/guide/setup.md)'
  );
  assert.equal(r.count, 3);
});

test('a name that another archive also has is left alone, and the new name is made unique', () => {
  const others = ['Archives/Alpha.mdz', 'Elsewhere/Beta.mdz'];
  const ambiguous = rewriteLinksIntoArchive('[x](Alpha.mdz/a.md)', 'Home.md', rename('Projects/Alpha.mdz', 'Projects/Beta.mdz', others));
  assert.equal(ambiguous.count, 0);
  const unique = rewriteLinksIntoArchive('[x](Projects/Alpha.mdz/a.md)', 'Home.md', rename('Projects/Alpha.mdz', 'Projects/Beta.mdz', others));
  assert.equal(unique.text, '[x](Projects/Beta.mdz/a.md)');
});

test('links to other archives, notes, URLs and code are untouched', () => {
  const note = [
    '[o](Other.mdz/a.md) [n](Alpha.md) [u](https://x.org/Alpha.mdz/a.md)',
    '`[c](Alpha.mdz/a.md)`',
    '```',
    '[c](Alpha.mdz/a.md)',
    '```',
  ].join('\n');
  const r = rewriteLinksIntoArchive(note, 'Home.md', rename('Alpha.mdz', 'Beta.mdz', ['Other.mdz']));
  assert.equal(r.text, note);
  assert.equal(r.count, 0);
});

test('a note that moved along with the archive keeps its still-valid relative link', () => {
  // Folder Old/ → New/ moved both; from New/n.md, Alpha.mdz/a.md already points at New/Alpha.mdz.
  const r = rewriteLinksIntoArchive('[x](Alpha.mdz/a.md)', 'New/n.md', rename('Old/Alpha.mdz', 'New/Alpha.mdz'));
  assert.equal(r.count, 0);
});

test('angle-bracket links are rewritten without percent-encoding', () => {
  const r = rewriteLinksIntoArchive('[x](<My Book.mdz/ch 1.md>)', 'Home.md', rename('My Book.mdz', 'Our Book.mdz'));
  assert.equal(r.text, '[x](<Our Book.mdz/ch 1.md>)');
});
