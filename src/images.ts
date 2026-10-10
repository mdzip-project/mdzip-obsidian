import { Editor, EditorPosition } from 'obsidian';
import { MdzArchiveCore } from '@mdzip/core-js';

// Helpers for pasting and dropping images, shared by the .mdz view and the
// paste handling for regular Markdown notes.

/** Image files carried by a paste or drop, if any. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'));
}

/** File extension for an image, from its MIME type (or its name). */
export function imageExtension(file: File): string {
  switch (file.type.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
      return 'png';
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MdzArchiveCore.IMAGE_MIME_TYPES[ext] ? ext : 'png';
}

/** A file name without its extension, reduced to link-safe characters. */
export function safeFileStem(name: string): string {
  return name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Blank lines needed around an inserted image so it is its own paragraph.
 * A single newline between text and an image is a line break in Obsidian
 * but just a space in CommonMark (MDZip Studio, VS Code), which puts the
 * image inline with the text; a blank line renders the same everywhere.
 * Inside a list item, blockquote or table, insert as-is so the structure
 * isn't broken.
 */
export function blockPadding(
  editor: Editor,
  from: EditorPosition,
  to: EditorPosition
): { before: string; after: string } {
  const line = editor.getLine(from.line);
  if (/^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/.test(line)) return { before: '', after: '' };

  const hasText = (s: string) => s.trim().length > 0;
  const prevLine = from.line > 0 ? editor.getLine(from.line - 1) : '';
  const nextLine = to.line < editor.lastLine() ? editor.getLine(to.line + 1) : '';
  const textBefore = line.slice(0, from.ch);
  const textAfter = editor.getLine(to.line).slice(to.ch);

  const before = hasText(textBefore) ? '\n\n' : hasText(prevLine) ? '\n' : '';
  const after = hasText(textAfter) ? '\n\n' : hasText(nextLine) ? '\n' : '';
  return { before, after };
}

/** Document offset under the drop point, via the CodeMirror view behind Obsidian's Editor. */
export function dropPosition(editor: Editor, evt: DragEvent): number | null {
  const cm = (editor as Editor & { cm?: { posAtCoords(c: { x: number; y: number }): number | null } }).cm;
  return cm?.posAtCoords({ x: evt.clientX, y: evt.clientY }) ?? null;
}
