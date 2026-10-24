// The path of a new document in an archive, from what the user typed.

import { MdzArchiveCore } from '@mdzip/core-js';

export type NewDocumentPath = { path: string } | { error: string };

/**
 * Turn typed input into an archive path for a new Markdown document:
 * backslashes become `/`, a leading `/` or `./` is dropped, and `.md` is
 * added when there's no Markdown extension. Refuses invalid paths (spec
 * Section 5.4), root-level support-file names (Section 5.5), and paths that
 * match an existing entry ignoring case, since writing one would replace
 * that entry.
 */
export function newDocumentPath(input: string, existing: readonly string[]): NewDocumentPath {
  let path = input.trim().replace(/\\/g, '/');
  while (path.startsWith('/') || path.startsWith('./')) path = path.replace(/^\.?\//, '');
  if (!path) return { error: 'Enter a name for the document.' };
  if (path.endsWith('/')) return { error: 'Enter a file name after the folder.' };
  if (!MdzArchiveCore.isMarkdownFile(path)) path += '.md';

  const problem = MdzArchiveCore.validateArchivePath(path);
  if (problem) return { error: `${path}: ${problem}` };
  if (MdzArchiveCore.isSupportFile(path)) {
    return { error: `${path} is a support file name (it describes the archive). Use another name, or put it in a folder.` };
  }

  const lower = path.toLowerCase();
  for (const other of existing) {
    const otherLower = other.replace(/\/$/, '').toLowerCase();
    if (otherLower === lower) {
      return { error: other === path ? `${path} is already in the archive.` : `${other} is already in the archive.` };
    }
    if (lower.startsWith(`${otherLower}/`) && !other.endsWith('/')) return { error: `${other} is a file, not a folder.` };
    if (otherLower.startsWith(`${lower}/`)) return { error: `${path} is a folder in the archive.` };
  }
  return { path };
}

/** The starting text of a new document: a heading from its file name. */
export function newDocumentText(path: string): string {
  const title = MdzArchiveCore.basename(path).replace(/\.(md|markdown)$/i, '');
  return `# ${title}\n\n`;
}
