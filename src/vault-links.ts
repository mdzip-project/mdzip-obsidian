import { App, TFile, TFolder } from 'obsidian';
import { isBareName, isMdzName, LinkHost, LinkSource, LinkTarget, LinkUse, matchDocumentName, resolveLink, samePath } from './links';

/** What an archive contains, as far as link resolution needs to know. */
export interface ArchiveIndex {
  findEntry(entry: string): string | null;
  entryPoint: string | null;
}

/**
 * Supplies the open view's live view of an archive, when there is one, so
 * links see entries that were just saved. Returns null for archives that
 * aren't open.
 */
export type OpenArchiveLookup = (path: string) => ArchiveIndex | null;

/** Reads an archive's index from bytes (entries + entry point). */
export type ArchiveReader = (bytes: ArrayBuffer) => Promise<ArchiveIndex>;

/**
 * Resolves links between the vault and .mdz archives (spec Sections 9.3–9.5),
 * with the vault as the host filesystem.
 */
export class VaultLinks {
  private cache = new Map<string, { mtime: number; index: Promise<ArchiveIndex | null> }>();

  constructor(
    private app: App,
    private openArchive: OpenArchiveLookup,
    private readArchive: ArchiveReader,
    /** Whether embeds may load vault files from outside an archive (spec Section 9.6). */
    private loadOutsideResources: () => boolean = () => false
  ) {}

  /** Resolve `link` written in `from`. `use` is 'embed' for images and other resources loaded automatically. */
  resolve(from: LinkSource, link: string, use: LinkUse = 'navigate'): Promise<LinkTarget> {
    return resolveLink(from, link, this.host(), use);
  }

  /**
   * Resolve a link written in a regular vault note that names an archive
   * using Obsidian's own link rules — vault-absolute paths or the shortest
   * unique name, e.g. `Project.mdz/docs/design.md` when `Project.mdz` lives
   * in another folder. Returns null if the link doesn't contain an archive
   * that Obsidian can find.
   */
  async resolveByName(sourcePath: string, link: string): Promise<LinkTarget | null> {
    const hashAt = link.indexOf('#');
    const dest = hashAt >= 0 ? link.slice(0, hashAt) : link;
    const rest = hashAt >= 0 ? link.slice(hashAt) : '';
    const segs = dest.split('/');
    const at = segs.findIndex((s) => isMdzName(safeDecode(s)));
    if (at < 0) return null;
    const archive = this.app.metadataCache.getFirstLinkpathDest(safeDecode(segs.slice(0, at + 1).join('/')), sourcePath);
    if (!(archive instanceof TFile) || archive.extension.toLowerCase() !== 'mdz') return null;
    // Re-resolve as a link written right next to the archive.
    const parent = archive.parent && archive.parent.path !== '/' ? `${archive.parent.path}/` : '';
    return this.resolve({ host: `${parent}.mdz-link-source` }, [archive.name, ...segs.slice(at + 1)].join('/') + rest);
  }

  /**
   * Resolve a link written in document `doc` of `archive`, as Obsidian users
   * write them: first by the spec's path rules; then, for an extensionless
   * link (wikilinks leave off `.md`), with `.md` added; then, for a bare
   * name, by matching an archive document's name (spec Section 9.7: name
   * lookups consider the archive's documents first). Returns the strict
   * result if none of those match, so callers can fall back to Obsidian's
   * vault-wide lookup for bare names.
   */
  async resolveInArchive(
    archive: string,
    doc: string,
    link: string,
    docs: string[],
    use: LinkUse = 'navigate'
  ): Promise<LinkTarget> {
    const from = { archive, path: doc };
    let strict = await this.resolve(from, link, use);
    if (strict.kind === 'unresolved' && strict.reason === 'invalid' && /%(?![0-9A-Fa-f]{2})/.test(link)) {
      // Wikilinks aren't percent-encoded (Section 9.7): read a stray `%` as a literal one.
      strict = await this.resolve(from, link.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'), use);
    }
    if (strict.kind !== 'unresolved' || strict.reason !== 'not-found') return strict;

    const hashAt = link.indexOf('#');
    const dest = hashAt >= 0 ? link.slice(0, hashAt) : link;
    const fragment = hashAt >= 0 ? link.slice(hashAt) : '';
    if (!/\.[^/.]+$/.test(dest)) {
      const withMd = await this.resolve(from, `${dest}.md${fragment}`, use);
      if (withMd.kind !== 'unresolved') return withMd;
    }
    if (isBareName(dest)) {
      const entry = matchDocumentName(docs, safeDecode(dest));
      if (entry) return { kind: 'internal', entry, ...(fragment.length > 1 ? { fragment: fragment.slice(1) } : {}) };
    }
    return strict;
  }

  /** The entry point of an archive in the vault, or null. */
  async entryPointOf(archivePath: string): Promise<string | null> {
    return (await this.index(archivePath))?.entryPoint ?? null;
  }

  /** Forget a cached archive index (e.g. after it changes on disk). */
  invalidate(path: string): void {
    this.cache.delete(path);
  }

  private host(): LinkHost {
    return {
      kind: (path) => {
        const file = this.lookup(path);
        if (file instanceof TFolder) return 'directory';
        if (file instanceof TFile) return file.extension.toLowerCase() === 'mdz' ? 'archive' : 'file';
        return null;
      },
      findEntry: async (archive, entry) => (await this.index(archive))?.findEntry(entry) ?? null,
      entryPoint: async (archive) => (await this.index(archive))?.entryPoint ?? null,
      // The vault is the trust boundary; vault paths can't reach outside it anyway.
      trustRoot: '',
      loadOutsideResources: this.loadOutsideResources(),
    };
  }

  /** Vault lookup that tolerates NFC/NFD differences in stored paths. */
  private lookup(path: string) {
    const vault = this.app.vault;
    return (
      vault.getAbstractFileByPath(path) ??
      vault.getAbstractFileByPath(path.normalize('NFC')) ??
      vault.getAbstractFileByPath(path.normalize('NFD'))
    );
  }

  /** Path of the vault file for a host path, as Obsidian stores it. */
  vaultFile(path: string): TFile | null {
    const file = this.lookup(path);
    return file instanceof TFile ? file : null;
  }

  private async index(archivePath: string): Promise<ArchiveIndex | null> {
    const open = this.openArchive(archivePath);
    if (open) return open;
    const file = this.vaultFile(archivePath);
    if (!file) return null;
    const cached = this.cache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.index;
    const index = this.app.vault
      .readBinary(file)
      .then((bytes) => this.readArchive(bytes))
      .catch(() => null);
    this.cache.set(file.path, { mtime: file.stat.mtime, index });
    return index;
  }
}

/** An ArchiveIndex over a list of entry paths. */
export function indexOf(entries: string[], entryPoint: string | null): ArchiveIndex {
  return {
    findEntry: (entry) => entries.find((e) => samePath(e, entry)) ?? null,
    entryPoint,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
