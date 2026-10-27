// Moving, renaming and removing archive entries, and creating folders.
//
// Kept free of Obsidian imports so it can be tested directly.

import { MdzArchiveCore, MdzPackagerCore } from '@mdzip/core-js';
import { linkedEntries, rewriteLinks } from './link-rewrite.ts';

/** An archive's files and its directory entries (`folder/`). */
export interface Listing {
  files: string[];
  dirs: string[];
}

export type Planned<T> = T | { error: string };

export function listingOf(archive: MdzArchiveCore): Listing {
  const entries = archive.listEntries({ includeDirectories: true });
  return {
    files: entries.filter((e) => !e.isDirectory).map((e) => e.path),
    dirs: entries.filter((e) => e.isDirectory).map((e) => e.path),
  };
}

/** Every folder, from directory entries and from file paths, without a trailing `/`. */
export function foldersOf(listing: Listing): string[] {
  const folders = new Set<string>();
  for (const dir of listing.dirs) folders.add(dir.replace(/\/$/, ''));
  for (const file of listing.files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return [...folders].sort();
}

/** Typed input as an archive path: `/` separators, no leading or trailing `/`. */
function cleanPath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/^(\.?\/)+/, '').replace(/\/+$/, '');
}

const lower = (path: string) => path.toLowerCase();

/** Why `path` can't be added next to `listing`'s entries (other than `ignoring`), or null. */
function conflict(listing: Listing, folders: string[], path: string, isFolder: boolean, ignoring: Set<string>): string | null {
  const key = lower(path);
  for (const file of listing.files) {
    if (ignoring.has(file)) continue;
    if (lower(file) === key) return `${file} is already in the archive.`;
    if (key.startsWith(`${lower(file)}/`)) return `${file} is a file, not a folder.`;
  }
  for (const folder of folders) {
    if (lower(folder) === key) return isFolder ? `The folder ${folder} already exists.` : `${folder} is a folder.`;
  }
  return null;
}

/** The path of a new folder, from what the user typed. */
export function newFolderPath(input: string, listing: Listing): Planned<{ path: string }> {
  const path = cleanPath(input);
  if (!path) return { error: 'Enter a name for the folder.' };
  const problem = MdzArchiveCore.validateArchivePath(`${path}/`);
  if (problem) return { error: `${path}: ${problem}` };
  const why = conflict(listing, foldersOf(listing), path, true, new Set());
  return why ? { error: why } : { path };
}

/**
 * Where every entry goes when `source` (a file, or with `isFolder` a folder
 * and everything in it) moves to `target`. A file keeps its extension if the
 * target leaves it off. Directory entries are keyed with their trailing `/`.
 */
export function planMove(
  listing: Listing,
  source: string,
  input: string,
  isFolder: boolean
): Planned<{ target: string; moves: Map<string, string> }> {
  let target = cleanPath(input);
  if (!target) return { error: 'Enter a path.' };
  if (!isFolder) {
    const ext = /\.[^/.]+$/.exec(source)?.[0] ?? '';
    if (ext && !/\.[^/.]+$/.test(target)) target += ext;
  }
  if (target === source) return { error: 'That is where it is now.' };
  if (source === 'manifest.json' || target === 'manifest.json') return { error: "manifest.json can't be moved or replaced." };
  if (isFolder && lower(target).startsWith(`${lower(source)}/`)) return { error: "A folder can't be moved into itself." };

  const moves = new Map<string, string>();
  if (isFolder) {
    const prefix = `${source}/`;
    for (const file of listing.files) if (file.startsWith(prefix)) moves.set(file, target + file.slice(source.length));
    for (const dir of listing.dirs) if (dir.startsWith(prefix)) moves.set(dir, target + dir.slice(source.length));
  } else {
    moves.set(source, target);
  }
  if (!moves.size) return { error: `${source} isn't in the archive.` };

  const problem = MdzArchiveCore.validateArchivePath(isFolder ? `${target}/` : target);
  if (problem) return { error: `${target}: ${problem}` };
  // Entries that are moving away don't block the new path (a case-only rename, say).
  const folders = foldersOf(listing).filter((f) => !(isFolder && (f === source || f.startsWith(`${source}/`))));
  const why = conflict(listing, folders, target, isFolder, new Set(moves.keys()));
  if (why) return { error: why };
  for (const next of moves.values()) {
    if (MdzArchiveCore.validateArchivePath(next)) return { error: `${next}: ${MdzArchiveCore.validateArchivePath(next)}` };
  }
  return { target, moves };
}

/** The entries removed when `source` (a file, or with `isFolder` a folder) is deleted. */
export function planRemove(listing: Listing, source: string, isFolder: boolean): string[] {
  if (!isFolder) return listing.files.filter((f) => f === source);
  const prefix = `${source}/`;
  return [...listing.files.filter((f) => f.startsWith(prefix)), ...listing.dirs.filter((d) => d.startsWith(prefix))];
}

/** The archive's raw manifest object, or null when it has none. */
async function rawManifest(archive: MdzArchiveCore): Promise<Record<string, unknown> | null> {
  const entry = archive.findEntry('manifest.json') as { async(kind: 'text'): Promise<string> } | null;
  if (!entry) return null;
  const parsed: unknown = JSON.parse(await entry.async('text'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * A `manifest.json` write with `change` applied, keeping every other field as
 * it is; or, for an archive with none, a new manifest naming `entryPoint`.
 */
async function manifestWrite(
  archive: MdzArchiveCore,
  entryPoint: string,
  mode: 'document' | 'project',
  change: (manifest: Record<string, unknown>) => void
): Promise<{ path: string; content: string }> {
  const manifest =
    (await rawManifest(archive)) ??
    (MdzPackagerCore.createManifest({ entryPoint, mode }) as unknown as Record<string, unknown>);
  change(manifest);
  return { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) };
}

interface ArchiveFacts {
  /** The entry point and mode as the view resolved them. */
  entryPoint: string;
  mode: 'document' | 'project';
}

async function readText(archive: MdzArchiveCore, path: string): Promise<string> {
  const entry = archive.findEntry(path) as { async(kind: 'text'): Promise<string> } | null;
  return entry ? entry.async('text') : '';
}

async function readBytes(archive: MdzArchiveCore, path: string): Promise<Uint8Array> {
  const entry = archive.findEntry(path) as { async(kind: 'uint8array'): Promise<Uint8Array> } | null;
  return entry ? entry.async('uint8array') : new Uint8Array();
}

export interface MoveResult {
  bytes: ArrayBuffer;
  /** Documents (by their new path) whose links were updated. */
  rewritten: string[];
}

/**
 * Apply `moves`, updating links in every document so they still point at the
 * same entries, and the manifest's entry point and cover if they moved.
 */
export async function applyMoves(bytes: ArrayBuffer, moves: ReadonlyMap<string, string>, facts: ArchiveFacts): Promise<MoveResult> {
  const archive = await MdzArchiveCore.open(new Uint8Array(bytes));
  const listing = listingOf(archive);
  const before = { files: listing.files };
  const after = { files: listing.files.map((f) => moves.get(f) ?? f) };

  const writes: { path: string; content: string | Uint8Array }[] = [];
  const rewritten: string[] = [];
  for (const file of listing.files) {
    const to = moves.get(file) ?? file;
    if (MdzArchiveCore.isMarkdownFile(file)) {
      const text = await readText(archive, file);
      const next = rewriteLinks(text, { from: file, to, moves, before, after });
      if (next !== text) {
        writes.push({ path: to, content: next });
        rewritten.push(to);
        continue;
      }
    }
    if (to !== file) writes.push({ path: to, content: await readBytes(archive, file) });
  }
  for (const [from, to] of moves) if (from.endsWith('/')) writes.push({ path: to, content: '' });

  const entryPoint = moves.get(facts.entryPoint) ?? facts.entryPoint;
  const manifest = await rawManifest(archive);
  const cover = typeof manifest?.cover === 'string' ? manifest.cover : null;
  if (entryPoint !== facts.entryPoint || (cover && moves.has(cover)) || !manifest) {
    // Written explicitly, since a moved entry point has to be named (spec Section 14.1).
    writes.push(
      await manifestWrite(archive, entryPoint, facts.mode, (m) => {
        m.entryPoint = entryPoint;
        if (cover && moves.has(cover)) m.cover = moves.get(cover);
      })
    );
  }
  const result = await MdzArchiveCore.updateFiles(new Uint8Array(bytes), writes, [...moves.keys()]);
  return { bytes: await result.blob.arrayBuffer(), rewritten };
}

/** Documents, other than ones being removed, that link to any of `removed`. */
export async function linksInto(archive: MdzArchiveCore, removed: string[]): Promise<string[]> {
  const gone = new Set(removed);
  const { files } = listingOf(archive);
  const from: string[] = [];
  for (const doc of files) {
    if (gone.has(doc) || !MdzArchiveCore.isMarkdownFile(doc)) continue;
    const targets = linkedEntries(await readText(archive, doc), doc, { files });
    if (targets.some((t) => gone.has(t) && t !== doc)) from.push(doc);
  }
  return from;
}

/** Why `removed` can't be removed, or null. */
export function removeProblem(removed: string[], facts: ArchiveFacts): string | null {
  if (removed.includes('manifest.json')) return "manifest.json can't be deleted.";
  if (removed.includes(facts.entryPoint)) {
    return `${facts.entryPoint} is the entry point. Make another document the entry point first.`;
  }
  return null;
}

/** Remove entries (files and directory entries); a removed cover image is cleared from the manifest. */
export async function applyRemove(bytes: ArrayBuffer, removed: string[], facts: ArchiveFacts): Promise<ArrayBuffer> {
  const problem = removeProblem(removed, facts);
  if (problem) throw new Error(problem);
  const archive = await MdzArchiveCore.open(new Uint8Array(bytes));
  const manifest = await rawManifest(archive);
  const writes =
    !manifest || (typeof manifest.cover === 'string' && removed.includes(manifest.cover))
      ? [
          await manifestWrite(archive, facts.entryPoint, facts.mode, (m) => {
            m.entryPoint = m.entryPoint ?? facts.entryPoint;
            if (typeof m.cover === 'string' && removed.includes(m.cover)) delete m.cover;
          }),
        ]
      : [];
  const result = await MdzArchiveCore.updateFiles(new Uint8Array(bytes), writes, removed);
  return result.blob.arrayBuffer();
}

/** Add an empty folder (a directory entry). */
export async function applyNewFolder(bytes: ArrayBuffer, path: string): Promise<ArrayBuffer> {
  const result = await MdzArchiveCore.updateFiles(new Uint8Array(bytes), [{ path: `${path}/`, content: '' }]);
  return result.blob.arrayBuffer();
}

/** Make `path` the entry point, recorded in the manifest. */
export async function applyEntryPoint(bytes: ArrayBuffer, path: string, facts: ArchiveFacts): Promise<ArrayBuffer> {
  const archive = await MdzArchiveCore.open(new Uint8Array(bytes));
  const write = await manifestWrite(archive, path, facts.mode, (m) => {
    m.entryPoint = path;
  });
  const result = await MdzArchiveCore.updateFiles(new Uint8Array(bytes), [write]);
  return result.blob.arrayBuffer();
}
