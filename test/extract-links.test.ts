import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks } from '../src/links.ts';

const links = (md: string) => extractLinks(md).map((l) => `${l.wiki ? 'W' : 'M'}${l.embed ? '!' : ''} ${l.link}`);

test('inline links and images', () => {
  assert.deepEqual(links('See [notes](../Notes.md) and ![logo](images/logo.png "Logo").'), [
    'M ../Notes.md',
    'M! images/logo.png',
  ]);
});

test('angle-bracket destinations with spaces', () => {
  assert.deepEqual(links('[a](<My Notes.md>)'), ['M My Notes.md']);
});

test('wikilinks and embeds, without alias', () => {
  assert.deepEqual(links('[[intro]] [[chapters/intro#Background|the intro]] ![[cover.png]]'), [
    'W intro',
    'W chapters/intro#Background',
    'W! cover.png',
  ]);
});

test('reference definitions', () => {
  assert.deepEqual(links('[x][ref]\n\n[ref]: guide/setup.md "Setup"\n'), ['M guide/setup.md']);
});

test('HTML href and src', () => {
  assert.deepEqual(links('<a href="../Notes.md">n</a> <img src=\'images/a.png\' width="40">'), [
    'M ../Notes.md',
    'M! images/a.png',
  ]);
});

test('skips URLs, fragment-only links and code', () => {
  const md = [
    '[site](https://mdzip.org) [top](#top) [mail](mailto:a@b.c)',
    '`[not](a.md)`',
    '```',
    '[not](b.md) [[not-c]]',
    '```',
    '~~~md',
    '[not](d.md)',
    '~~~',
    '[yes](e.md)',
  ].join('\n');
  assert.deepEqual(links(md), ['M e.md']);
});
