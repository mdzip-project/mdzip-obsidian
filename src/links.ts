// Link resolution for MDZip archives, per the MDZip spec (1.2.0-draft)
// Sections 9.3–9.5: links inside an archive, links that leave it for files
// next to the .mdz, and links into (other) archives.
//
// Kept free of Obsidian imports so it can be tested against the spec's
// examples/fixtures/link-resolution-cases.json (see test/links.test.ts).

export type UnresolvedReason = 'not-found' | 'invalid' | 'unsupported' | 'no-host-location' | 'nested-archive';

export type LinkTarget =
  /** An entry of the archive the link is in. */
  | { kind: 'internal'; entry: string; fragment?: string }
  /** A file on the host (in Obsidian: a vault path). */
  | { kind: 'host'; path: string; fragment?: string }
  /** An entry of an archive addressed through the host (possibly the source archive). */
  | { kind: 'archive'; archive: string; entry: string; fragment?: string }
  /** Not a path: a URL with a scheme. */
  | { kind: 'url' }
  | { kind: 'unresolved'; reason: UnresolvedReason };

/** Where a link is written: a document inside an archive, or a host file. */
export type LinkSource = { archive: string; path: string } | { host: string };

export interface LinkHost {
  /** What exists at a host path: a file, a directory, an MDZip archive, or nothing. */
  kind(path: string): 'file' | 'directory' | 'archive' | null;
  /** The stored entry path in `archive` matching `entry` (NFC, case-sensitive), or null. */
  findEntry(archive: string, entry: string): Promise<string | null>;
  /** The entry point of `archive` (Section 5.5), or null if it can't be determined. */
  entryPoint(archive: string): Promise<string | null>;
  /** False when the source archive has no host location (opened from bytes). Default true. */
  hostLocation?: boolean;
  /** Whether links outside an archive are supported (Section 9.4). Default true. */
  outsideLinks?: boolean;
  /** Whether links into archives are supported (Section 9.5). Default true. */
  intoArchiveLinks?: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BAD_SEGMENT = /[/\\\u0000-\u001f\u007f]/;

/** True for a name with an `.mdz` extension, compared ASCII case-insensitively. */
export function isMdzName(name: string): boolean {
  return /\.mdz$/.test(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

function dirSegments(path: string): string[] {
  const i = path.lastIndexOf('/');
  return i < 0 ? [] : path.slice(0, i).split('/').filter(Boolean);
}

/**
 * Split a destination into decoded segments (Section 9.3 steps 3–4), or null
 * if it isn't a valid relative link. Decoding is lenient about malformed
 * `%` sequences, since Obsidian hands over link text that may already be
 * decoded (for example `100% done.md`).
 */
function segmentsOf(dest: string): string[] | null {
  if (dest.startsWith('/') || dest.includes('\\')) return null;
  const segs: string[] = [];
  for (const raw of dest.split('/')) {
    let s = raw;
    try {
      s = decodeURIComponent(raw);
    } catch {
      // Not valid percent-encoding: use the text as written.
    }
    if (BAD_SEGMENT.test(s)) return null;
    segs.push(s);
  }
  return segs;
}

/** Resolve `link` written in `from`, following Sections 9.3–9.5. */
export async function resolveLink(from: LinkSource, link: string, host: LinkHost): Promise<LinkTarget> {
  if (SCHEME.test(link)) return { kind: 'url' };

  const hashAt = link.indexOf('#');
  const fragment = hashAt >= 0 ? link.slice(hashAt + 1) : '';
  let dest = hashAt >= 0 ? link.slice(0, hashAt) : link;
  const queryAt = dest.indexOf('?');
  if (queryAt >= 0) dest = dest.slice(0, queryAt);
  const withFragment = <T extends LinkTarget>(t: T): T => (fragment ? { ...t, fragment } : t);

  // A fragment-only link points at the referencing document itself.
  if (dest === '') {
    return 'archive' in from
      ? withFragment({ kind: 'internal', entry: from.path })
      : withFragment({ kind: 'host', path: from.host });
  }

  const segs = segmentsOf(dest);
  if (!segs) return { kind: 'unresolved', reason: 'invalid' };

  let stack: string[];
  let i = 0;

  if ('archive' in from) {
    // Inside the source archive until a `..` climbs above its root.
    stack = dirSegments(from.path);
    let left = false;
    for (; i < segs.length; i++) {
      const s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (stack.length === 0) {
          left = true;
          i++;
          break;
        }
        stack.pop();
      } else {
        stack.push(s);
      }
    }
    if (!left) {
      const entry = await host.findEntry(from.archive, stack.join('/'));
      return entry ? withFragment({ kind: 'internal', entry }) : { kind: 'unresolved', reason: 'not-found' };
    }
    // Left the archive (Section 9.4): continue from the directory containing it.
    if (host.outsideLinks === false) return { kind: 'unresolved', reason: 'unsupported' };
    if (host.hostLocation === false) return { kind: 'unresolved', reason: 'no-host-location' };
    stack = dirSegments(from.archive);
  } else {
    stack = dirSegments(from.host);
  }

  // On the host, watching for an archive boundary (Section 9.5).
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (stack.length === 0) return { kind: 'unresolved', reason: 'not-found' };
      stack.pop();
      continue;
    }
    stack.push(s);
    const hostPath = stack.join('/');
    if (isMdzName(s) && host.kind(hostPath) === 'archive') {
      if (host.intoArchiveLinks === false) return { kind: 'unresolved', reason: 'unsupported' };
      return resolveInsideArchive(hostPath, segs.slice(i + 1), host, withFragment);
    }
  }

  const hostPath = stack.join('/');
  return host.kind(hostPath) === 'file'
    ? withFragment({ kind: 'host', path: hostPath })
    : { kind: 'unresolved', reason: 'not-found' };
}

async function resolveInsideArchive(
  archive: string,
  segs: string[],
  host: LinkHost,
  withFragment: <T extends LinkTarget>(t: T) => T
): Promise<LinkTarget> {
  const inner: string[] = [];
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j];
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (inner.length === 0) return { kind: 'unresolved', reason: 'invalid' };
      inner.pop();
      continue;
    }
    inner.push(s);
    // A second archive boundary (an archive inside this one) isn't supported.
    if (isMdzName(s) && j < segs.length - 1) return { kind: 'unresolved', reason: 'nested-archive' };
  }
  if (inner.length === 0) {
    const entryPoint = await host.entryPoint(archive);
    return entryPoint
      ? withFragment({ kind: 'archive', archive, entry: entryPoint })
      : { kind: 'unresolved', reason: 'not-found' };
  }
  const entry = await host.findEntry(archive, inner.join('/'));
  return entry ? withFragment({ kind: 'archive', archive, entry }) : { kind: 'unresolved', reason: 'not-found' };
}

/** A link found in Markdown text. */
export interface FoundLink {
  /** The destination as written (wikilinks: target plus any `#heading`, without the alias). */
  link: string;
  /** Wikilink or embed syntax (`[[...]]`), resolved by name (spec Section 9.7). */
  wiki: boolean;
  /** Image or embed (`![...](...)`, `![[...]]`, `<img src>`). */
  embed: boolean;
}

/**
 * Find the links in Markdown text: inline links and images, reference
 * definitions, wikilinks and embeds, and HTML `href` / `src` attributes.
 * Code blocks and inline code are skipped. External URLs are left out;
 * fragment-only links (`#heading`) are left out too, since they point at the
 * same document.
 */
export function extractLinks(markdown: string): FoundLink[] {
  const text = markdown
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm, '')
    .replace(/`+[^`\n]*`+/g, '');
  const found: FoundLink[] = [];
  const add = (link: string, wiki: boolean, embed: boolean) => {
    const l = link.trim();
    if (l && !l.startsWith('#') && !SCHEME.test(l) && !l.startsWith('//')) found.push({ link: l, wiki, embed });
  };

  for (const m of text.matchAll(/(!?)\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g)) add(m[2], true, m[1] === '!');
  for (const m of text.matchAll(/(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
    add(m[2].replace(/^<|>$/g, ''), false, m[1] === '!');
  }
  for (const m of text.matchAll(/^[ ]{0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) add(m[1].replace(/^<|>$/g, ''), false, false);
  for (const m of text.matchAll(/<(a|img)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    add(m[2] ?? m[3] ?? '', false, m[1].toLowerCase() === 'img');
  }
  return found;
}

/**
 * The archive document a bare name refers to, Obsidian-style: an exact path,
 * the path plus `.md`, or a document whose file name (without extension)
 * equals the name, ignoring case. Prefers the shortest path when several
 * documents share the name.
 */
export function matchDocumentName(docs: string[], name: string): string | null {
  const wanted = name.toLowerCase();
  const exact = docs.find((d) => samePath(d, name) || samePath(d, `${name}.md`));
  if (exact) return exact;
  const byName = docs
    .filter((d) => {
      const file = (d.split('/').pop() ?? '').toLowerCase();
      return file === wanted || file.replace(/\.(md|markdown)$/, '') === wanted;
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return byName[0] ?? null;
}

/** True when some segment of the link's path names an `.mdz` archive. */
export function mentionsArchive(link: string): boolean {
  const dest = link.split('#')[0];
  return dest.split('/').some((s) => isMdzName(safeDecode(s)));
}

/**
 * True for a bare name — one path segment, not `.` or `..` — such as an
 * Obsidian wikilink `[[Notes]]`. Hosts like Obsidian look these up by name
 * across the vault rather than as relative paths.
 */
export function isBareName(link: string): boolean {
  const dest = link.split('#')[0];
  return dest !== '' && dest !== '.' && dest !== '..' && !dest.includes('/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** NFC, case-sensitive path equality (spec Section 5.4.1). */
export function samePath(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}
