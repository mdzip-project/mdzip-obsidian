// The archive contents tree shown in the "Archive contents" pane, and the
// check for images no document refers to. Kept free of Obsidian imports so
// it can be tested on its own (see test/contents-tree.test.ts).

import { extractLinks, resolveLink, samePath, type LinkHost } from './links.ts';

/** An archive entry, as listed by MdzArchiveCore.listEntries(). */
export interface ContentsEntry {
  path: string;
  isMarkdown: boolean;
  isImage: boolean;
  isDirectory: boolean;
  size?: number;
}

export type ContentsKind = 'folder' | 'document' | 'image' | 'manifest' | 'file';

export interface ContentsNode {
  /** Last path segment. */
  name: string;
  /** Archive path (folders: without a trailing `/`). */
  path: string;
  kind: ContentsKind;
  children: ContentsNode[];
  /** The archive's entry point (spec Section 5.5). */
  entryPoint?: boolean;
  /** A root-level support file such as README.md or AGENTS.md (spec Section 5.5). */
  support?: boolean;
  size?: number;
}

const SUPPORT_NAMES = ['readme', 'agents', 'license', 'changelog', 'contributing'];

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** True for a root-level support file (spec Section 5.5), compared ASCII case-insensitively. */
export function isSupportFile(path: string): boolean {
  if (path.includes('/')) return false;
  const m = /^(.*)\.(md|markdown)$/.exec(asciiLower(path));
  return !!m && SUPPORT_NAMES.includes(m[1]);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then files, in natural order (as Obsidian's file explorer sorts). */
function compareNodes(a: ContentsNode, b: ContentsNode): number {
  const aFolder = a.kind === 'folder';
  const bFolder = b.kind === 'folder';
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Build the contents tree. Folders come from file paths and from any
 * directory entries (which may be empty). At the root, the entry point is
 * pinned first; everything else is sorted like Obsidian's file explorer.
 */
export function buildContentsTree(entries: ContentsEntry[], entryPoint: string): ContentsNode[] {
  const root: ContentsNode = { name: '', path: '', kind: 'folder', children: [] };
  const folders = new Map<string, ContentsNode>([['', root]]);

  const folder = (path: string): ContentsNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parent = folder(slash < 0 ? '' : path.slice(0, slash));
    const node: ContentsNode = { name: path.slice(slash + 1), path, kind: 'folder', children: [] };
    parent.children.push(node);
    folders.set(path, node);
    return node;
  };

  for (const entry of entries) {
    if (entry.isDirectory) {
      const path = entry.path.replace(/\/+$/, '');
      if (path) folder(path);
      continue;
    }
    const slash = entry.path.lastIndexOf('/');
    const parent = folder(slash < 0 ? '' : entry.path.slice(0, slash));
    const name = entry.path.slice(slash + 1);
    const kind: ContentsKind =
      entry.path === 'manifest.json' ? 'manifest' : entry.isMarkdown ? 'document' : entry.isImage ? 'image' : 'file';
    const node: ContentsNode = { name, path: entry.path, kind, children: [] };
    if (entry.size !== undefined) node.size = entry.size;
    if (kind === 'document' && samePath(entry.path, entryPoint)) node.entryPoint = true;
    if (kind === 'document' && isSupportFile(entry.path)) node.support = true;
    parent.children.push(node);
  }

  const sort = (node: ContentsNode): void => {
    node.children.sort(compareNodes);
    node.children.forEach(sort);
  };
  sort(root);
  const pinned = root.children.findIndex((n) => n.entryPoint);
  if (pinned > 0) root.children.unshift(...root.children.splice(pinned, 1));
  return root.children;
}

/**
 * The tree cut down to entries whose path contains `query`
 * (case-insensitive), with the folders that lead to them. A folder whose own
 * path matches keeps all of its contents. Order is kept. Pure.
 */
export function filterContentsTree(nodes: ContentsNode[], query: string): ContentsNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes;
  const keep = (node: ContentsNode): ContentsNode | null => {
    if (node.path.toLocaleLowerCase().includes(needle)) return node;
    if (node.kind !== 'folder') return null;
    const children = node.children.map(keep).filter((n): n is ContentsNode => n !== null);
    return children.length ? { ...node, children } : null;
  };
  return nodes.map(keep).filter((n): n is ContentsNode => n !== null);
}

/** Every node in the tree, depth first. */
export function walk(nodes: ContentsNode[]): ContentsNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children)]);
}

/**
 * Images that no document of the archive refers to — through a Markdown or
 * HTML link, a wikilink or embed (matched by name or path), or the
 * manifest's `cover`. Only images are reported, as mdzip-editor does: other
 * files may be used by tools or extensions without any link (spec Section 8).
 */
export async function findUnreferencedImages(
  entries: ContentsEntry[],
  readText: (path: string) => Promise<string | null>,
  cover?: string
): Promise<Set<string>> {
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const images = files.filter((p) => entries.find((e) => e.path === p)?.isImage);
  const unreferenced = new Set(images);
  if (!unreferenced.size) return unreferenced;

  if (cover) {
    const c = cover.replace(/^\.\//, '');
    for (const img of images) if (samePath(img, c)) unreferenced.delete(img);
  }

  const host: LinkHost = {
    kind: () => null,
    findEntry: async (_archive, entry) => files.find((p) => samePath(p, entry)) ?? null,
    entryPoint: async () => null,
    // Only links inside the archive matter here.
    hostLocation: false,
  };
  const byName = (name: string): string[] => {
    const wanted = name.replace(/^\.\//, '');
    return images.filter((p) => samePath(p, wanted) || samePath(p.slice(p.lastIndexOf('/') + 1), wanted) || p.endsWith(`/${wanted}`));
  };

  for (const doc of files.filter((p) => entries.find((e) => e.path === p)?.isMarkdown)) {
    if (!unreferenced.size) break;
    const text = await readText(doc);
    if (!text) continue;
    for (const found of extractLinks(text)) {
      if (found.wiki) {
        for (const img of byName(found.link.split('#')[0])) unreferenced.delete(img);
        continue;
      }
      const target = await resolveLink({ archive: '', path: doc }, found.link, host);
      if (target.kind === 'internal') unreferenced.delete(target.entry);
    }
  }
  return unreferenced;
}
