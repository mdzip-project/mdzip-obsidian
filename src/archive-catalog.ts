import { App, CachedMetadata, debounce, TAbstractFile, TFile } from 'obsidian';
import { MdzArchiveCore } from '@mdzip/core-js';
import { unzipSync } from 'fflate';
import { extractLinks, mentionsArchive } from './links';
import { openArchive } from './mdz-view';
import { VaultLinks } from './vault-links';

/** What the catalog knows about one archive. */
export interface ArchiveSummary {
  path: string;
  entryPoint: string;
  /** Markdown documents in the archive. */
  docs: string[];
  /** Outgoing links per document, as graph node ids (see nodeId). */
  links: Map<string, string[]>;
  /** Links per document that don't resolve, as written. */
  unresolved: Map<string, string[]>;
}

/** targetNode result for a link that doesn't resolve. */
const UNRESOLVED = Symbol('unresolved');

/** A link from a regular note to a document inside an archive. */
export interface NoteToArchiveLink {
  /** Graph node id of the archive document. */
  target: string;
  /**
   * The id Obsidian's graph gives this link as an unresolved node: the link
   * path without its fragment or `.md` extension.
   */
  unresolvedId: string;
}

export interface SearchMatch {
  archive: string;
  doc: string;
  /** 0-based line number. */
  line: number;
  text: string;
  /** Match position within `text`. */
  start: number;
  end: number;
}

/**
 * Graph node id for a document inside an archive. The entry point is the
 * archive itself, so links to `Project.mdz` and to its entry document meet
 * at one node; other documents are `Project.mdz/<entry path>` (the stable
 * identity from spec Section 9.5).
 */
export function nodeId(archive: string, entry: string, entryPoint: string): string {
  return entry === entryPoint ? archive : `${archive}/${entry}`;
}

/**
 * Index of the vault's .mdz archives for the graph and search: their
 * documents and links, and regular notes' links into them. Rebuilt per
 * archive when it changes (by mtime); document text is read one document at
 * a time and not kept.
 */
export class ArchiveCatalog {
  private archives = new Map<string, { mtime: number; summary: Promise<ArchiveSummary | null> }>();
  private noteLinks = new Map<string, NoteToArchiveLink[]>();
  private listeners = new Set<() => void>();
  private notifyLater = debounce(() => this.listeners.forEach((l) => l()), 300, true);

  constructor(
    private app: App,
    private links: VaultLinks
  ) {}

  /** Call when something in the catalog changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Index every archive and note; call once the layout is ready. */
  async build(): Promise<void> {
    await Promise.all(this.archiveFiles().map((f) => this.summary(f)));
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.indexNote(file, this.app.metadataCache.getFileCache(file));
    }
    this.notifyLater();
  }

  // ---- Change tracking (wired up by the plugin) ----

  onFileChanged(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (isArchive(file)) {
      this.archives.delete(file.path);
      void this.summary(file).then(() => this.notifyLater());
    }
  }

  onFileDeleted(file: TAbstractFile): void {
    this.archives.delete(file.path);
    this.noteLinks.delete(file.path);
    this.notifyLater();
  }

  onFileRenamed(file: TAbstractFile, oldPath: string): void {
    this.archives.delete(oldPath);
    this.noteLinks.delete(oldPath);
    this.onFileChanged(file);
  }

  async onMetadataChanged(file: TFile, cache: CachedMetadata | null): Promise<void> {
    const before = JSON.stringify(this.noteLinks.get(file.path) ?? []);
    await this.indexNote(file, cache);
    if (JSON.stringify(this.noteLinks.get(file.path) ?? []) !== before) this.notifyLater();
  }

  // ---- Snapshot for the graph ----

  /** Archives indexed so far. */
  async summaries(): Promise<ArchiveSummary[]> {
    const all = await Promise.all(this.archiveFiles().map((f) => this.summary(f)));
    return all.filter((s): s is ArchiveSummary => s !== null);
  }

  /** Links from regular notes into archives, per note path. */
  noteToArchiveLinks(): ReadonlyMap<string, NoteToArchiveLink[]> {
    return this.noteLinks;
  }

  // ---- Search ----

  /**
   * Search the text of every document in every archive (case-insensitive,
   * on demand, no stored index), smallest archives first. Calls `onMatch` for each match as it is
   * found; stops early when `isCancelled()` returns true or after `limit`
   * matches.
   */
  async search(
    query: string,
    onMatch: (match: SearchMatch) => void,
    isCancelled: () => boolean,
    limit = 1000
  ): Promise<number> {
    const needle = query.toLocaleLowerCase();
    if (!needle) return 0;
    let count = 0;
    // Smallest archives first, so quick results appear before large archives are scanned.
    for (const file of this.archiveFiles().sort((a, b) => a.stat.size - b.stat.size || a.path.localeCompare(b.path))) {
      if (isCancelled()) break;
      let bytes: Uint8Array;
      let docs: string[];
      try {
        bytes = new Uint8Array(await this.app.vault.readBinary(file));
        docs = markdownDocs((await openArchive(bytes.buffer as ArrayBuffer)).archive);
      } catch {
        continue;
      }
      for (const doc of docs) {
        if (isCancelled() || count >= limit) return count;
        const text = inflateText(bytes, doc);
        if (text === null || !text.toLocaleLowerCase().includes(needle)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && count < limit; i++) {
          const at = lines[i].toLocaleLowerCase().indexOf(needle);
          if (at < 0) continue;
          onMatch({ archive: file.path, doc, line: i, text: lines[i], start: at, end: at + needle.length });
          count++;
        }
        // Yield so the UI stays responsive on large archives.
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }
    return count;
  }

  // ---- Internals ----

  private archiveFiles(): TFile[] {
    return this.app.vault.getFiles().filter(isArchive);
  }

  private summary(file: TFile): Promise<ArchiveSummary | null> {
    const cached = this.archives.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.summary;
    const summary = this.readSummary(file).catch(() => null);
    this.archives.set(file.path, { mtime: file.stat.mtime, summary });
    return summary;
  }

  private async readSummary(file: TFile): Promise<ArchiveSummary> {
    const buffer = await this.app.vault.readBinary(file);
    const bytes = new Uint8Array(buffer);
    const { archive, entryPointPath } = await openArchive(buffer);
    const docs = markdownDocs(archive);
    const links = new Map<string, string[]>();
    const unresolved = new Map<string, string[]>();
    for (const doc of docs) {
      const text = inflateText(bytes, doc);
      if (text === null) continue;
      const targets = new Set<string>();
      const missing = new Set<string>();
      for (const found of extractLinks(text)) {
        if (found.embed) continue; // images and embeds aren't graph edges
        const id = await this.targetNode(file.path, doc, found.link, docs, entryPointPath);
        if (id === UNRESOLVED) missing.add(found.link);
        else if (id) targets.add(id);
      }
      links.set(doc, [...targets]);
      if (missing.size) unresolved.set(doc, [...missing]);
      await new Promise((r) => window.setTimeout(r, 0));
    }
    return { path: file.path, entryPoint: entryPointPath, docs, links, unresolved };
  }

  /**
   * Graph node id that a link in an archive document points to, if it's a
   * Markdown document; null if it resolves to something else (an image, a
   * PDF); UNRESOLVED if it doesn't resolve.
   */
  private async targetNode(
    archive: string,
    doc: string,
    link: string,
    docs: string[],
    entryPoint: string
  ): Promise<string | null | typeof UNRESOLVED> {
    const target = await this.links.resolveInArchive(archive, doc, link, docs);
    switch (target.kind) {
      case 'internal':
        return MdzArchiveCore.isMarkdownFile(target.entry) ? nodeId(archive, target.entry, entryPoint) : null;
      case 'archive': {
        if (!MdzArchiveCore.isMarkdownFile(target.entry)) return null;
        const otherEntry = target.archive === archive ? entryPoint : await this.links.entryPointOf(target.archive);
        return nodeId(target.archive, target.entry, otherEntry ?? target.entry);
      }
      case 'host':
        return /\.md$/i.test(target.path) ? target.path : null;
      default: {
        // Bare names that aren't in the archive: Obsidian's vault-wide lookup.
        if (target.kind === 'url') return null;
        const dest = this.app.metadataCache.getFirstLinkpathDest(link.split('#')[0], archive);
        if (!dest) return UNRESOLVED;
        return dest.extension === 'md' ? dest.path : null;
      }
    }
  }

  private async indexNote(file: TFile, cache: CachedMetadata | null): Promise<void> {
    const found: NoteToArchiveLink[] = [];
    for (const ref of [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])]) {
      if (!mentionsArchive(ref.link)) continue;
      let target = await this.links.resolve({ host: file.path }, ref.link);
      if (target.kind === 'unresolved') target = (await this.links.resolveByName(file.path, ref.link)) ?? target;
      if (target.kind !== 'archive' || !MdzArchiveCore.isMarkdownFile(target.entry)) continue;
      const entryPoint = await this.links.entryPointOf(target.archive);
      found.push({
        target: nodeId(target.archive, target.entry, entryPoint ?? target.entry),
        unresolvedId: ref.link.split('#')[0].replace(/\.md$/i, ''),
      });
    }
    if (found.length) this.noteLinks.set(file.path, found);
    else this.noteLinks.delete(file.path);
  }
}

function isArchive(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === 'mdz';
}

function markdownDocs(archive: MdzArchiveCore): string[] {
  return archive
    .listEntries()
    .filter((e) => e.isMarkdown && !e.isDirectory)
    .map((e) => e.path);
}

const decoder = new TextDecoder();

/**
 * Decompress one entry's text with fflate, which is several times faster
 * than going through JSZip for large archives (and only this one entry is
 * inflated). Returns null if the entry is missing or unreadable.
 */
function inflateText(bytes: Uint8Array, path: string): string | null {
  try {
    const out = unzipSync(bytes, { filter: (f) => normalizeEntryName(f.name) === path });
    const data = Object.values(out)[0];
    return data ? decoder.decode(data) : null;
  } catch {
    return null;
  }
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}
