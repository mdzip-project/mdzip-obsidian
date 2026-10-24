import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocumentPath, newDocumentText } from '../src/document-path.ts';

const existing = ['index.md', 'manifest.json', 'docs/', 'docs/guide.md', 'images/logo.png', 'notes'];

test('adds .md, normalizes separators and leading slashes', () => {
  assert.deepEqual(newDocumentPath('chapter-2', existing), { path: 'chapter-2.md' });
  assert.deepEqual(newDocumentPath('  docs\\setup  ', existing), { path: 'docs/setup.md' });
  assert.deepEqual(newDocumentPath('/docs/a.md', existing), { path: 'docs/a.md' });
  assert.deepEqual(newDocumentPath('./b.markdown', existing), { path: 'b.markdown' });
  assert.deepEqual(newDocumentPath('new/folder/c', existing), { path: 'new/folder/c.md' });
});

test('refuses empty names and folders without a file name', () => {
  assert.ok('error' in newDocumentPath('', existing));
  assert.ok('error' in newDocumentPath('  / ', existing));
  assert.ok('error' in newDocumentPath('docs/', existing));
});

test('refuses invalid archive paths', () => {
  assert.ok('error' in newDocumentPath('../outside', existing));
  assert.ok('error' in newDocumentPath('docs/../x', existing));
  assert.ok('error' in newDocumentPath('a//b', existing));
});

test('refuses root-level support file names, but not in a folder', () => {
  assert.ok('error' in newDocumentPath('README', existing));
  assert.ok('error' in newDocumentPath('license.md', existing));
  assert.deepEqual(newDocumentPath('docs/README', existing), { path: 'docs/README.md' });
});

test('refuses existing entries, ignoring case', () => {
  assert.match((newDocumentPath('index', existing) as { error: string }).error, /already/);
  assert.match((newDocumentPath('Docs/Guide.md', existing) as { error: string }).error, /docs\/guide\.md is already/);
});

test('refuses a path under a file, or one that is a folder', () => {
  assert.match((newDocumentPath('notes/a', existing) as { error: string }).error, /is a file/);
  assert.match((newDocumentPath('x.md', ['x.md/y.png']) as { error: string }).error, /is a folder/);
});

test('starting text is a heading from the file name', () => {
  assert.equal(newDocumentText('docs/Setup Guide.md'), '# Setup Guide\n\n');
});
