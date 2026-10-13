import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContentsTree, findUnreferencedImages, isSupportFile, walk, type ContentsEntry } from '../src/contents-tree.ts';

const entry = (path: string, extra: Partial<ContentsEntry> = {}): ContentsEntry => ({
  path,
  isMarkdown: /\.(md|markdown)$/i.test(path),
  isImage: /\.(png|jpe?g|gif|svg|webp)$/i.test(path),
  isDirectory: path.endsWith('/'),
  ...extra,
});

test('entry point first, then folders, then files in natural order', () => {
  const tree = buildContentsTree(
    ['manifest.json', 'README.md', 'zeta.md', 'index.md', 'chapter10.md', 'chapter2.md', 'images/b.png', 'docs/a.md'].map((p) =>
      entry(p)
    ),
    'zeta.md'
  );
  assert.deepEqual(
    tree.map((n) => n.name),
    ['zeta.md', 'docs', 'images', 'chapter2.md', 'chapter10.md', 'index.md', 'manifest.json', 'README.md']
  );
  assert.equal(tree[0].entryPoint, true);
  assert.equal(tree.find((n) => n.name === 'manifest.json')?.kind, 'manifest');
  assert.equal(tree.find((n) => n.name === 'README.md')?.support, true);
});

test('nested folders, empty directory entries and kinds', () => {
  const tree = buildContentsTree(
    [entry('guide/setup.md'), entry('guide/img/shot.png'), entry('empty/'), entry('data/table.csv')],
    'guide/setup.md'
  );
  const nodes = walk(tree);
  assert.deepEqual(
    nodes.map((n) => `${n.path}:${n.kind}`),
    ['data:folder', 'data/table.csv:file', 'empty:folder', 'guide:folder', 'guide/img:folder', 'guide/img/shot.png:image', 'guide/setup.md:document']
  );
  assert.equal(nodes.find((n) => n.path === 'guide/setup.md')?.entryPoint, true);
});

test('support files are root-level only, ASCII case-insensitive', () => {
  assert.ok(isSupportFile('AGENTS.MD'));
  assert.ok(isSupportFile('license.markdown'));
  assert.ok(!isSupportFile('docs/README.md'));
  assert.ok(!isSupportFile('README-draft.md'));
});

test('images referenced by links, wikilink embeds, HTML or the cover are not reported', async () => {
  const docs: Record<string, string> = {
    'index.md': '# Home\n\n![a](images/a.png)\n\n<img src="images/b.png">\n\nSee [the guide](guide/setup.md).\n',
    'guide/setup.md': '![[c.png]]\n\n![d](../images/d%20e.png)\n\n```\n![not this](images/code.png)\n```\n',
  };
  const entries = [
    'index.md',
    'guide/setup.md',
    'images/a.png',
    'images/b.png',
    'images/c.png',
    'images/d e.png',
    'images/code.png',
    'images/cover.png',
    'images/unused.png',
    'data/table.csv',
  ].map((p) => entry(p));
  const unreferenced = await findUnreferencedImages(entries, async (p) => docs[p] ?? null, './images/cover.png');
  assert.deepEqual([...unreferenced].sort(), ['images/code.png', 'images/unused.png']);
});
