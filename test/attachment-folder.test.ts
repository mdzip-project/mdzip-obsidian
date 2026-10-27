import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentFolder, describeFolder } from '../src/attachment-folder.ts';

test('a fixed folder, with or without slashes', () => {
  assert.equal(attachmentFolder('Attachments', 'People'), 'Attachments');
  assert.equal(attachmentFolder('/Media/Images/', 'People'), 'Media/Images');
});

test("the vault's top folder", () => {
  assert.equal(attachmentFolder('/', 'People'), '');
  assert.equal(attachmentFolder(undefined, 'People'), '');
  assert.equal(attachmentFolder('', 'People'), '');
});

test("the note's own folder", () => {
  assert.equal(attachmentFolder('./', 'People'), 'People');
  assert.equal(attachmentFolder('./', ''), '');
  assert.equal(attachmentFolder('./', '/'), '');
});

test("a subfolder of the note's folder", () => {
  assert.equal(attachmentFolder('./assets', 'People/Scientists'), 'People/Scientists/assets');
  assert.equal(attachmentFolder('./assets/', ''), 'assets');
});

test('described for people', () => {
  assert.equal(describeFolder('Attachments'), 'Attachments/');
  assert.equal(describeFolder(''), "the vault's top folder");
});
