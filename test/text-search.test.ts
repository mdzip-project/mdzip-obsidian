import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLines } from '../src/text-search.ts';

const text = '# Tomatoes\nSix plants in Bed 1.\r\nPlanted out after the last frost\nNo match here\nplants again, PLANTS';

test('finds each matching line, case-insensitively, with its position', () => {
  assert.deepEqual(matchLines(text, 'PLANT'), [
    { line: 1, text: 'Six plants in Bed 1.', start: 4, end: 9 },
    { line: 2, text: 'Planted out after the last frost', start: 0, end: 5 },
    { line: 4, text: 'plants again, PLANTS', start: 0, end: 5 },
  ]);
});

test('stops at the limit', () => {
  assert.equal(matchLines(text, 'plant', 2).length, 2);
  assert.deepEqual(matchLines(text, 'plant', 0), []);
});

test('an empty query or missing text matches nothing', () => {
  assert.deepEqual(matchLines(text, ''), []);
  assert.deepEqual(matchLines(text, 'cucumber'), []);
});
