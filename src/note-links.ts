// Keeping links from notes into an archive's documents (`Project.mdz/docs/x.md`)
// working when the archive itself is renamed or moved. Obsidian updates links
// to the .mdz file, but sees links into it as unresolved, so it leaves them.
//
// Kept free of Obsidian imports so it can be tested directly.

import { findLinkSpans, relativePath } from './link-rewrite.ts';
import { samePath } from './links.ts';

export interface ArchiveRename {
  /** Vault paths of the archive before and after. */
  from: string;
  to: string;
  /** Every other .mdz in the vault, for telling name-only links apart. */
  others: string[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MDZ = /\.mdz$/i;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** `dir/link` with `.` and `..` resolved; null if it climbs above the vault. */
function join(dir: string, link: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const s of link.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}

/** `path` ends with the whole segments of `suffix` (or is it). */
function endsWithSegments(path: string, suffix: string): boolean {
  return samePath(path, suffix) || path.toLowerCase().endsWith(`/${suffix.toLowerCase()}`);
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => (s === '..' || s === '.' || s === '' ? s : encodeURIComponent(s)))
    .join('/');
}

/** The shortest trailing part of `path` that no other archive ends with, as Obsidian's "shortest" link format would write it. */
function shortestName(path: string, others: string[]): string {
  const segs = path.split('/');
  for (let n = 1; n < segs.length; n++) {
    const suffix = segs.slice(-n).join('/');
    if (!others.some((o) => endsWithSegments(o, suffix))) return suffix;
  }
  return path;
}

/**
 * Rewrite the links in a note (at `notePath`) that point to a document
 * inside the renamed archive, keeping each link's style: relative to the
 * note, from the vault root, or by the archive's name. Links to the archive
 * itself are left to Obsidian. Returns the new text and how many links
 * changed.
 */
export function rewriteLinksIntoArchive(
  markdown: string,
  notePath: string,
  rename: ArchiveRename
): { text: string; count: number } {
  const noteDir = dirOf(notePath);
  let out = '';
  let last = 0;
  let count = 0;
  for (const span of findLinkSpans(markdown)) {
    if (span.syntax === 'html') continue; // notes link with Markdown and wikilinks
    const written = markdown.slice(span.start, span.end);
    const link = written.trim();
    if (!link || link.startsWith('#') || link.startsWith('//') || SCHEME.test(link)) continue;
    const cut = span.syntax === 'wiki' ? link.search(/[#|]/) : link.search(/[?#]/);
    const rawPath = cut < 0 ? link : link.slice(0, cut);
    const suffix = cut < 0 ? '' : link.slice(cut);
    const raw = rawPath.split('/');
    const plain = span.syntax === 'wiki' || span.angled;
    const segs = raw.map((s) => (plain ? s : decode(s)));
    if (segs.some((s) => s === null)) continue;
    const k = segs.findIndex((s) => MDZ.test(s!));
    if (k < 0 || k === segs.length - 1) continue; // no archive, or a link to the archive itself

    const archivePart = segs.slice(0, k + 1).join('/');
    const absolute = archivePart.startsWith('/');
    const fromVault = absolute ? archivePart.slice(1) : archivePart;
    let replacement: string;
    const relative = absolute ? null : join(noteDir, archivePart);
    // Already pointing at the new place (e.g. the note moved along with it).
    if ((relative !== null && samePath(relative, rename.to)) || samePath(fromVault, rename.to)) continue;
    if (relative !== null && samePath(relative, rename.from)) {
      replacement = relativePath(noteDir, rename.to);
    } else if (samePath(fromVault, rename.from)) {
      replacement = (absolute ? '/' : '') + rename.to;
    } else if (
      !absolute &&
      endsWithSegments(rename.from, archivePart) &&
      // A name another archive also answers to may mean that one: leave it.
      !rename.others.some((o) => endsWithSegments(o, archivePart))
    ) {
      replacement = shortestName(rename.to, rename.others);
    } else {
      continue;
    }

    const rest = raw.slice(k + 1).join('/');
    const next = (plain ? replacement : encodePath(replacement)) + '/' + rest + suffix;
    out += markdown.slice(last, span.start) + written.replace(link, next);
    last = span.end;
    count++;
  }
  return { text: last === 0 ? markdown : out + markdown.slice(last), count };
}
