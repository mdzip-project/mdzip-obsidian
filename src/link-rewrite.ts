// Finding and rewriting links inside an archive's documents, so that moving
// or renaming entries keeps every link pointing where it did.
//
// Kept free of Obsidian imports so it can be tested directly.

import { matchDocumentName, samePath } from './links.ts';

/** A link destination's place in Markdown text. */
export interface LinkSpan {
  /** Offsets of the destination as written (inside `<...>` or quotes, without them). */
  start: number;
  end: number;
  /** `wiki`: `[[...]]` / `![[...]]`; `markdown`: inline links, images and reference definitions; `html`: `href` / `src`. */
  syntax: 'wiki' | 'markdown' | 'html';
  /** Written as `<...>`, so spaces are allowed and it isn't percent-encoded. */
  angled: boolean;
}

/** Fenced code blocks and inline code, blanked out (same length) so links in them are skipped. */
function maskCode(markdown: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return markdown
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm, blank)
    .replace(/`+[^`\n]*`+/g, blank);
}

/**
 * Every link destination in the text: the same syntaxes `extractLinks`
 * reads (links.ts), with their positions so they can be replaced.
 */
export function findLinkSpans(markdown: string): LinkSpan[] {
  const text = maskCode(markdown);
  const spans: LinkSpan[] = [];
  for (const m of text.matchAll(/(!?\[\[)([^\]|]+?)(?:\|[^\]]*)?\]\]/g)) {
    const start = m.index + m[1].length;
    spans.push({ start, end: start + m[2].length, syntax: 'wiki', angled: false });
  }
  const markdownDest = (m: RegExpMatchArray, prefix: string, dest: string) => {
    const angled = dest.startsWith('<') && dest.endsWith('>');
    const start = m.index! + prefix.length + (angled ? 1 : 0);
    spans.push({ start, end: start + dest.length - (angled ? 2 : 0), syntax: 'markdown', angled });
  };
  for (const m of text.matchAll(
    /(!?\[(?:[^\]\\\n]|\\.)*\]\(\s*)(<[^>\n]*>|[^)\s]+)(?=(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/g
  )) {
    markdownDest(m, m[1], m[2]);
  }
  for (const m of text.matchAll(/^([ ]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/gm)) markdownDest(m, m[1], m[2]);
  for (const m of text.matchAll(/(<(?:a|img)\b[^>]*?\s(?:href|src)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = m[2] ?? m[3] ?? '';
    const start = m.index + m[1].length + 1;
    spans.push({ start, end: start + value.length, syntax: 'html', angled: false });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The files of an archive, for resolving links. */
export interface EntryIndex {
  /** File paths (no directory entries). */
  files: string[];
}

/** Where a link inside an archive points. */
export type Ref =
  | { kind: 'entry'; path: string }
  /** Outside the archive: the path from the directory holding the `.mdz` (may start with `..`). */
  | { kind: 'outside'; path: string };

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function depthOf(path: string): number {
  const dir = dirOf(path);
  return dir ? dir.split('/').length : 0;
}

/** `..` segments collapsed where they can be; leading ones are kept. */
function normalizeRelative(segs: string[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

function find(files: string[], path: string): string | null {
  return files.find((f) => samePath(f, path)) ?? null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HAS_EXTENSION = /\.[^/.]+$/;
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Resolve a decoded link path (no fragment) written in `from`, the way the
 * view does for links inside an archive (`VaultLinks.resolveInArchive`): by
 * relative path; then with `.md` added when it has no extension; then, for a
 * bare name, by document name. A path that climbs above the archive root
 * points outside it. Returns null when it doesn't resolve.
 *
 * With `strict`, only the relative path counts (spec Section 9.3), which is
 * how other MDZip tools read Markdown and HTML links.
 */
export function resolveRef(from: string, dest: string, index: EntryIndex, strict = false): Ref | null {
  if (!dest || dest.startsWith('/') || dest.includes('\\')) return null;
  const walk = (link: string): Ref | string => {
    const stack = dirOf(from) ? dirOf(from).split('/') : [];
    const segs = link.split('/');
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (!stack.length) return { kind: 'outside', path: normalizeRelative(['..', ...segs.slice(i + 1)]) };
        stack.pop();
      } else {
        stack.push(s);
      }
    }
    return stack.join('/');
  };

  const byPath = walk(dest);
  if (typeof byPath !== 'string') return byPath;
  const found = find(index.files, byPath);
  if (found) return { kind: 'entry', path: found };
  if (strict) return null;
  if (!HAS_EXTENSION.test(dest)) {
    const withMd = walk(`${dest}.md`);
    const foundMd = typeof withMd === 'string' ? find(index.files, withMd) : null;
    if (foundMd) return { kind: 'entry', path: foundMd };
  }
  if (!dest.includes('/') && dest !== '.' && dest !== '..') {
    const docs = index.files.filter((f) => MARKDOWN.test(f));
    const byName = matchDocumentName(docs, dest);
    if (byName) return { kind: 'entry', path: byName };
  }
  return null;
}

function sameRef(a: Ref | null, b: Ref): boolean {
  return !!a && a.kind === b.kind && samePath(a.path, b.path);
}

/** A relative link from directory `fromDir` (`''` is the root) to archive path `to`. */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const parts = to.split('/');
  const toDir = parts.slice(0, -1);
  let common = 0;
  while (common < from.length && common < toDir.length && from[common] === toDir[common]) common++;
  return '../'.repeat(from.length - common) + parts.slice(common).join('/');
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
    .map((s) => (s === '..' || s === '.' ? s : encodeURIComponent(s)))
    .join('/');
}

export interface DocumentMove {
  /** The document's path before and after the change (the same when it doesn't move). */
  from: string;
  to: string;
  /** Entry paths before → after, for every entry that moves. */
  moves: ReadonlyMap<string, string>;
  /** The archive's files before and after the change. */
  before: EntryIndex;
  after: EntryIndex;
}

/**
 * Rewrite a document's links so that each one that resolved before the
 * change resolves to the same thing after it: links to moved entries follow
 * them, and a moved document's own relative links are re-based. Links that
 * still resolve correctly are left exactly as written (so bare wikilink
 * names stay bare), as are links that didn't resolve to begin with.
 */
export function rewriteLinks(markdown: string, change: DocumentMove): string {
  let out = '';
  let last = 0;
  for (const span of findLinkSpans(markdown)) {
    const written = markdown.slice(span.start, span.end);
    const next = rewriteOne(written, span, change);
    if (next === null || next === written) continue;
    out += markdown.slice(last, span.start) + next;
    last = span.end;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}

function rewriteOne(written: string, span: LinkSpan, change: DocumentMove): string | null {
  const link = written.trim();
  if (!link || link.startsWith('#') || link.startsWith('//') || SCHEME.test(link)) return null;
  const cut = span.syntax === 'wiki' ? link.search(/#/) : link.search(/[?#]/);
  const pathPart = cut < 0 ? link : link.slice(0, cut);
  const suffix = cut < 0 ? '' : link.slice(cut);
  // Wikilinks aren't percent-encoded; read a stray `%` as itself.
  const dest = span.syntax === 'wiki' || span.angled ? (decode(pathPart) ?? pathPart) : decode(pathPart);
  if (!dest) return null;

  // A Markdown or HTML link that resolves by its path must still do so after
  // the change, so it keeps working in other MDZip tools; wikilinks, and links
  // that only worked through Obsidian's name lookup, may keep relying on it.
  const strict = span.syntax !== 'wiki' && resolveRef(change.from, dest, change.before, true) !== null;
  const before = resolveRef(change.from, dest, change.before, strict);
  if (!before) return null;
  const expected: Ref =
    before.kind === 'entry' ? { kind: 'entry', path: change.moves.get(before.path) ?? before.path } : before;
  const resolvesTo = (link: string) => sameRef(resolveRef(change.to, link, change.after, strict), expected);
  if (resolvesTo(dest)) return null;

  let replacement: string;
  if (expected.kind === 'outside') {
    replacement = '../'.repeat(depthOf(change.to)) + expected.path;
  } else {
    const rel = relativePath(dirOf(change.to), expected.path);
    const candidates: string[] = [];
    const isDoc = MARKDOWN.test(expected.path);
    if (span.syntax === 'wiki' && !dest.includes('/') && isDoc) {
      candidates.push((expected.path.split('/').pop() ?? '').replace(MARKDOWN, ''));
    }
    if (!HAS_EXTENSION.test(dest) && isDoc) candidates.push(rel.replace(MARKDOWN, ''));
    candidates.push(rel);
    replacement = candidates.find(resolvesTo) ?? rel;
  }
  const encoded = span.syntax === 'wiki' || span.angled ? replacement : encodePath(replacement);
  return written.replace(link, encoded + suffix);
}

/** The archive entries a document links to (resolved, inside the archive). */
export function linkedEntries(markdown: string, from: string, index: EntryIndex): string[] {
  const found = new Set<string>();
  for (const span of findLinkSpans(markdown)) {
    const link = markdown.slice(span.start, span.end).trim();
    if (!link || link.startsWith('#') || link.startsWith('//') || SCHEME.test(link)) continue;
    const cut = span.syntax === 'wiki' ? link.search(/#/) : link.search(/[?#]/);
    const pathPart = cut < 0 ? link : link.slice(0, cut);
    const dest = decode(pathPart) ?? pathPart;
    const ref = resolveRef(from, dest, index);
    if (ref?.kind === 'entry') found.add(ref.path);
  }
  return [...found];
}
