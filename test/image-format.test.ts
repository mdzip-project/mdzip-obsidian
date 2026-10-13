import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatImage, imageSize } from '../src/image-format.ts';

// Expected strings are what mdzip-editor's formatImageInsertMarkdown produces
// (packages/editor/src/view.ts), so archives get the same markup in every tool.

test('Markdown image, with alt text escaped', () => {
  assert.equal(formatImage('images/a.png', { mode: 'markdown', altText: 'A [big] cat' }), '![A [big\\] cat](images/a.png)');
});

test('HTML image with size, inline', () => {
  assert.equal(
    formatImage('images/a.png', { mode: 'html', altText: `Cat & "dog's"`, width: 320, position: 'inline' }),
    '<img src="images/a.png" alt="Cat &amp; &quot;dog&#39;s&quot;" width="320">'
  );
});

test('left, center and right wrap the image in <p align>', () => {
  for (const position of ['left', 'center', 'right'] as const) {
    assert.equal(
      formatImage('images/a.png', { mode: 'html', altText: 'x', width: 200, height: 100, position }),
      `<p align="${position}"><img src="images/a.png" alt="x" width="200" height="100"></p>`
    );
  }
});

test('wrap left and right put align on the <img>', () => {
  assert.equal(
    formatImage('images/a.png', { mode: 'html', altText: 'x', position: 'wrap-left' }),
    '<img src="images/a.png" alt="x" align="left">'
  );
  assert.equal(
    formatImage('images/a.png', { mode: 'html', altText: 'x', position: 'wrap-right' }),
    '<img src="images/a.png" alt="x" align="right">'
  );
});

test('sizes: width, height, percent of the real size, original', () => {
  const real = { width: 1000, height: 500 };
  assert.deepEqual(imageSize('width', 320, real), { width: 320 });
  assert.deepEqual(imageSize('height', 120.4, real), { height: 120 });
  assert.deepEqual(imageSize('percent', 25, real), { width: 250, height: 125 });
  assert.deepEqual(imageSize('percent', 25, undefined), {});
  assert.deepEqual(imageSize('original', 50, real), {});
  assert.deepEqual(imageSize('width', 0, real), {});
});
