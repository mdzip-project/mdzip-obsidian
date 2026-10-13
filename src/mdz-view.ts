import {
  App,
  debounce,
  Editor,
  FuzzySuggestModal,
  MarkdownView,
  Notice,
  PaneType,
  setTooltip,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
} from 'obsidian';
import { MdzArchiveCore } from '@mdzip/core-js';
import { blockPadding, dropPosition, imageExtension, imageFiles, safeFileStem } from './images';
import type { LinkTarget, LinkUse } from './links';
import { ArchiveIndex, indexOf, VaultLinks } from './vault-links';
import type { ImageInsertMode } from './image-format';
import { imageMarkup } from './image-insert-modal';

export const VIEW_TYPE_MDZ = 'mdz-document';

/** Archives above this size autosave less often (each save rewrites the whole file). */
const LARGE_ARCHIVE_BYTES = 25 * 1024 * 1024;
const LARGE_ARCHIVE_SAVE_DELAY_MS = 30_000;

/** Represents a JSZip entry with the async() read method. */
interface ZipEntryLike {
  dir: boolean;
  async(kind: 'text' | 'arraybuffer' | 'base64'): Promise<string | ArrayBuffer>;
}

/**
 * Obsidian's own Markdown view (live preview, source mode, reading view,
 * hotkeys, properties, etc.) backed by a .mdz archive.
 *
 * The view edits one Markdown document of the archive at a time: the entry
 * point in document mode, or any document of a project-mode archive. The
 * current document is part of the view state (`mdzDoc`), so tabs restore to
 * it and in-archive navigation goes through Obsidian's back/forward history.
 *
 * MarkdownView inherits its file I/O from TextFileView, which reads and
 * writes the file as plain text. This subclass swaps that I/O for archive
 * unpack/repack:
 *
 *  - `loadFileInternal` (TextFileView's internal loader, used on open) is
 *    overridden to read the current document out of the archive.
 *  - `onModify` re-reads the archive when the file changes on disk.
 *  - `save` (called by autosave, Mod+S and on close) writes the edited
 *    Markdown back into the archive, preserving every other entry.
 *
 * Images inside the archive don't exist in the vault, so Obsidian renders
 * them as "could not be found" embeds. A MutationObserver replaces those
 * with blob URLs read from the archive, in both live preview and reading
 * view.
 *
 * If the archive can't be loaded, `archiveBytes` stays null and `save` is a
 * no-op, so a failed load can never overwrite the .mdz with bad data.
 */
export class MdzView extends MarkdownView {
  private archiveBytes: ArrayBuffer | null = null;
  private archive: MdzArchiveCore | null = null;
  private isProject = false;
  private entryPointPath = 'index.md';
  /** Archive path of the Markdown document being edited. */
  private currentDoc = 'index.md';
  /** Document requested by the view state that is loading the file. */
  private pendingDoc: string | null = null;
  /**
   * Documents written since `archive` was opened. Saves update
   * `archiveBytes` but not the parsed `archive`, so reads go through this.
   */
  private savedDocs = new Map<string, string>();
  /** Markdown of the current document as last loaded from / written to the archive. */
  private lastSavedMarkdown: string | null = null;
  /** True while an archive write (or a queued one) is running. */
  private mdzSaving = false;
  /** Serializes archive writes so saves and image inserts never interleave. */
  private writeQueue: Promise<void> = Promise.resolve();
  private errorEl: HTMLElement | null = null;
  /** The current document's path, shown after the archive's name in the view header. */
  private headerDocEl: HTMLElement | null = null;
  /** Blob URL lookups for the current archive, keyed by archive path (cached as promises so concurrent passes share one URL). */
  private imageUrls = new Map<string, Promise<string | null>>();
  private resolveScheduled = false;
  /** Bumped whenever the archive changes; resolved images record the generation they point at. */
  private archiveGeneration = 0;
  /** Entry index for link resolution, rebuilt when the archive changes. */
  private entryIndex: { generation: number; index: ArchiveIndex } | null = null;
  private links: VaultLinks;

  constructor(
    leaf: WorkspaceLeaf,
    links: VaultLinks,
    /** The "Images pasted into archives" setting. */
    private imageMode: () => ImageInsertMode = () => 'markdown'
  ) {
    super(leaf);
    this.links = links;
    // TextFileView autosaves 2s after each change. For large archives that
    // means rewriting a big file constantly, so wait longer; Mod+S, closing
    // the tab and quitting still save immediately.
    const requestSave = this.requestSave;
    const requestSlowSave = debounce(() => void this.save(), LARGE_ARCHIVE_SAVE_DELAY_MS, true);
    this.requestSave = () => {
      if ((this.archiveBytes?.byteLength ?? 0) > LARGE_ARCHIVE_BYTES) {
        this.dirty = true;
        requestSlowSave();
      } else {
        requestSave();
      }
    };
  }

  getViewType(): string {
    return VIEW_TYPE_MDZ;
  }

  getIcon(): string {
    return 'package';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === 'mdz';
  }

  getState(): Record<string, unknown> {
    const state = super.getState();
    if (this.currentDoc !== this.entryPointPath) state.mdzDoc = this.currentDoc;
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as Record<string, unknown>;
    const doc = typeof s.mdzDoc === 'string' ? s.mdzDoc : null;

    if (!this.file || s.file !== this.file.path) {
      // Opening a file: load straight into the requested document.
      this.pendingDoc = doc;
      try {
        await super.setState(state, result);
      } finally {
        this.pendingDoc = null;
      }
      return;
    }

    await super.setState(state, result);
    const target = doc ?? this.entryPointPath;
    if (target !== this.currentDoc && (await this.showDocument(target))) {
      result.history = true;
    }
  }

  onload(): void {
    super.onload();
    const observer = new MutationObserver(() => this.scheduleImageResolve());
    observer.observe(this.contentEl, { childList: true, subtree: true });
    this.register(() => observer.disconnect());

    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor, info) => {
        if (info !== this || evt.defaultPrevented) return;
        const files = imageFiles(evt.clipboardData);
        if (!files.length) return;
        evt.preventDefault();
        void this.insertImages(files, editor, 'paste');
      })
    );
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, info) => {
        if (info !== this || evt.defaultPrevented) return;
        const files = imageFiles(evt.dataTransfer);
        if (!files.length) return;
        evt.preventDefault();
        void this.insertImages(files, editor, 'drop', evt);
      })
    );
    // Raw HTML links (`<a href="Author/Book.md">`) don't go through Obsidian's
    // link handling, so follow the ones that point into the archive here.
    this.registerDomEvent(this.contentEl, 'click', (evt) => this.followHtmlLink(evt), { capture: true });
    this.registerDomEvent(this.contentEl, 'auxclick', (evt) => this.followHtmlLink(evt), { capture: true });

    // Header actions: the archive's contents and the Archive links panel.
    this.addAction('folder-tree', 'Show archive contents', () => {
      (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(
        'mdzip-obsidian:show-contents'
      );
    });
    this.addAction('package-open', 'Show links for this document', () => {
      (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(
        'mdzip-obsidian:show-links'
      );
    });

    // Large archives may be holding unsaved edits for a while; flush them on quit.
    this.registerEvent(this.app.workspace.on('quit', (tasks) => tasks.add(() => this.save())));
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
    this.setArchive(null, null);
    this.lastSavedMarkdown = null;
    this.isProject = false;
    this.clearError();
    this.updateDocumentUi();
  }

  // ---- Loading ----

  /** Replaces TextFileView's plain-text loader (called from onLoadFile). */
  async loadFileInternal(file: TFile, clear: boolean): Promise<void> {
    this.clearError();
    try {
      const bytes = await this.app.vault.readBinary(file);
      const opened = await openArchive(bytes);
      const doc = pickDocument(opened.archive, this.pendingDoc, opened.entryPointPath);
      const markdown = await readDocument(opened.archive, doc);
      if (markdown === null) throw new Error(`document not found in archive: "${doc}"`);

      this.isProject = opened.mode === 'project';
      this.entryPointPath = opened.entryPointPath;
      this.currentDoc = doc;
      this.setArchive(bytes, opened.archive);
      this.lastSavedMarkdown = markdown;
      this.data = markdown;
      this.setViewData(markdown, clear);
    } catch (err) {
      this.setArchive(null, null);
      this.isProject = false;
      this.lastSavedMarkdown = null;
      this.data = '';
      this.setViewData('', clear);
      this.showError(err instanceof Error ? err.message : String(err));
    }
    this.updateDocumentUi();
  }

  /**
   * Obsidian pushes a view's text into every other view of the same file, so
   * panes showing one note stay in sync while typing. Two tabs on one archive
   * can show different documents, though: taking the other tab's text here
   * would later save it under this tab's document and overwrite it. So only
   * accept text from a tab showing the same document of the same archive.
   */
  onExternalDataChange(file: TFile, data: string): void {
    if (file !== this.file) return;
    const sameDocument = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_MDZ)
      .some(
        (leaf) =>
          leaf.view !== this &&
          leaf.view instanceof MdzView &&
          leaf.view.file === file &&
          leaf.view.currentDoc === this.currentDoc &&
          leaf.view.getViewData() === data
      );
    if (!sameDocument) return;
    const inherited = (Object.getPrototypeOf(MdzView.prototype) as { onExternalDataChange?: (f: TFile, d: string) => void })
      .onExternalDataChange;
    inherited?.call(this, file, data);
  }

  /** Re-load when the underlying file changes on disk (e.g. external edit). */
  onModify(file: TFile): void {
    if (this.mdzSaving || file !== this.file) return;
    void this.enqueue(() => this.reloadFromDisk(file));
  }

  private async reloadFromDisk(file: TFile): Promise<void> {
    if (this.file !== file) return;
    if (!this.archiveBytes) {
      // Previous load failed; try again from scratch.
      await this.loadFileInternal(file, false);
      return;
    }
    let bytes: ArrayBuffer;
    let opened: OpenedArchive;
    let markdown: string | null;
    try {
      bytes = await this.app.vault.readBinary(file);
      // The modify event from our own write.
      if (sameBytes(bytes, this.archiveBytes)) return;
      opened = await openArchive(bytes);
      markdown = await readDocument(opened.archive, this.currentDoc);
    } catch {
      return; // Keep the current state; the next successful change will reload.
    }
    if (this.file !== file) return;

    this.isProject = opened.mode === 'project';
    this.entryPointPath = opened.entryPointPath;
    this.setArchive(bytes, opened.archive);

    if (markdown === null) {
      // The document was removed externally; fall back to the entry point.
      new Notice(`"${this.currentDoc}" was removed from ${file.name}.`);
      const entry = (await readDocument(opened.archive, opened.entryPointPath)) ?? '';
      this.currentDoc = opened.entryPointPath;
      this.lastSavedMarkdown = entry;
      this.data = entry;
      this.setViewData(entry, true);
      this.updateDocumentUi();
      return;
    }
    this.updateDocumentUi();

    // A change that didn't touch this document.
    if (markdown === this.lastSavedMarkdown) return;

    const current = this.getViewData();
    const hasUnsavedEdits = current !== this.lastSavedMarkdown;
    this.lastSavedMarkdown = markdown;
    if (hasUnsavedEdits && current !== markdown) {
      new Notice(
        `${file.name} changed on disk. Keeping your unsaved edits; saving will overwrite the external change.`
      );
      return;
    }
    this.data = markdown;
    this.setViewData(markdown, false);
  }

  // ---- Documents ----

  /** Markdown documents in the archive, sorted by path. */
  listDocuments(): string[] {
    if (!this.archive) return [];
    return this.archive
      .listEntries()
      .filter((e) => e.isMarkdown && !e.isDirectory)
      .map((e) => e.path);
  }

  /** This archive's entries and entry point, for link resolution. */
  archiveIndex(): ArchiveIndex | null {
    if (!this.archive) return null;
    if (this.entryIndex?.generation !== this.archiveGeneration) {
      const entries = this.archive
        .listEntries()
        .filter((e) => !e.isDirectory)
        .map((e) => e.path);
      this.entryIndex = { generation: this.archiveGeneration, index: indexOf(entries, this.entryPointPath) };
    }
    return this.entryIndex.index;
  }

  /**
   * Resolve a link written in the current document: spec Sections 9.3–9.5,
   * plus name lookup within the archive for wikilinks (Section 9.7).
   */
  resolveLink(link: string, use: LinkUse = 'navigate'): Promise<LinkTarget> {
    if (!this.file) return Promise.resolve({ kind: 'unresolved', reason: 'not-found' });
    return this.links.resolveInArchive(this.file.path, this.currentDoc, link, this.cachedDocuments(), use);
  }

  private docsCache: { generation: number; docs: string[] } | null = null;

  private cachedDocuments(): string[] {
    if (this.docsCache?.generation !== this.archiveGeneration) {
      this.docsCache = { generation: this.archiveGeneration, docs: this.listDocuments() };
    }
    return this.docsCache.docs;
  }

  /**
   * Show a document of the archive, in this tab or (with `newLeaf`) another
   * one. Goes through the leaf's view state so it lands in back/forward
   * history.
   */
  async openDocument(path: string, newLeaf?: PaneType | boolean, subpath?: string): Promise<void> {
    const file = this.file;
    if (!file) return;
    const leaf = newLeaf ? this.app.workspace.getLeaf(newLeaf) : this.leaf;
    const base = leaf === this.leaf ? this.getState() : { file: file.path, mode: this.getMode() };
    await leaf.setViewState(
      { type: VIEW_TYPE_MDZ, state: { ...base, mdzDoc: path }, active: true },
      subpath ? { subpath } : undefined
    );
  }

  private followHtmlLink(evt: MouseEvent): void {
    if (evt.type === 'auxclick' && evt.button !== 1) return;
    const a = (evt.target as HTMLElement | null)?.closest?.('a[href]');
    if (!a || a.hasClass('internal-link') || a.hasClass('external-link')) return;
    const href = a.getAttribute('href') ?? '';
    if (!this.file || !href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      return;
    }
    // A relative href: resolve it like any other link from this document
    // (the plugin's openLinkText handling), rather than letting the browser
    // navigate the window.
    evt.preventDefault();
    evt.stopPropagation();
    void this.app.workspace.openLinkText(href, this.file.path, evt.button === 1 ? 'tab' : modPaneType(evt));
  }

  /** Save the current document, then switch the editor to `path`. */
  private async showDocument(path: string): Promise<boolean> {
    const file = this.file;
    if (!file) return false;
    let shown = false;
    await this.enqueue(async () => {
      if (this.file !== file || !this.archive) return;
      await this.writeArchive(file, []);
      const markdown = await this.readDoc(path);
      if (markdown === null) {
        new Notice(`"${path}" isn't in ${file.name}.`);
        return;
      }
      this.currentDoc = path;
      this.lastSavedMarkdown = markdown;
      this.data = markdown;
      this.setViewData(markdown, true);
      this.updateDocumentUi();
      // Lets the word count (and similar) pick up the new document, and the
      // graph move its focus to it.
      this.app.workspace.trigger('quick-preview', file, markdown);
      this.app.workspace.trigger('mdzip:document-open', this);
      shown = true;
    });
    return shown;
  }

  private async readDoc(path: string): Promise<string | null> {
    const saved = this.savedDocs.get(path);
    if (saved !== undefined) return saved;
    return this.archive ? readDocument(this.archive, path) : null;
  }

  /** Pick a document of the archive to open. */
  chooseDocument(): void {
    const documents = this.listDocuments();
    if (!documents.length) return;
    new DocumentPicker(this.app, documents, (path, evt) => {
      void this.openDocument(path, modPaneType(evt));
    }).open();
  }

  /**
   * Show the current document after the archive's name in the view header,
   * continuing Obsidian's breadcrumb: "Projects / Alpha Handbook / guide / setup".
   * Shown for project archives, and in document mode when off the entry point.
   * Folder parts open the Archive contents pane. Kept out of the (editable)
   * title, which renames the file.
   */
  private updateDocumentUi(): void {
    this.headerDocEl?.remove();
    this.headerDocEl = null;
    const container = (this as unknown as { titleContainerEl?: HTMLElement }).titleContainerEl;
    const show = !!this.archive && (this.isProject || this.currentDoc !== this.entryPointPath);
    if (!container || !show) return;

    const el = createSpan({ cls: 'mdz-header-doc' });
    const parts = this.currentDoc.split('/');
    parts.forEach((part, i) => {
      el.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
      if (i === parts.length - 1) {
        el.createSpan({ cls: 'mdz-header-doc-name', text: part.replace(/\.(md|markdown)$/i, '') });
      } else {
        const crumb = el.createSpan({ cls: 'view-header-breadcrumb', text: part });
        crumb.addEventListener('click', () => {
          (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(
            'mdzip-obsidian:show-contents'
          );
        });
      }
    });
    setTooltip(el, `${this.currentDoc} — a document inside ${this.file?.name ?? 'this archive'}`, { placement: 'bottom' });
    container.appendChild(el);
    this.headerDocEl = el;
  }

  // ---- Saving ----

  /** Replaces TextFileView's plain-text save with an archive repack. */
  async save(clear?: boolean): Promise<void> {
    this.dirty = false;
    const file = this.file;
    if (!file) return;
    await this.enqueue(() => this.writeArchive(file, []));
  }

  /**
   * Write the editor's Markdown, plus any new assets, into the archive in a
   * single file write. Only runs from the write queue.
   */
  private async writeArchive(file: TFile, assets: ArchiveAsset[]): Promise<void> {
    // The view may have switched files while this write was queued.
    if (this.file !== file || !this.archiveBytes) return;
    const markdown = this.getViewData();
    const doc = this.currentDoc;
    if (!assets.length && markdown === this.lastSavedMarkdown) return;

    try {
      let bytes = this.archiveBytes;
      for (const asset of assets) {
        const result = await MdzArchiveCore.addFile(new Uint8Array(bytes), asset.path, asset.bytes);
        bytes = await result.blob.arrayBuffer();
      }
      if (markdown !== this.lastSavedMarkdown) {
        const result = await MdzArchiveCore.addFile(new Uint8Array(bytes), doc, markdown);
        bytes = await result.blob.arrayBuffer();
      }
      await this.app.vault.modifyBinary(file, bytes);
      this.lastSavedMarkdown = markdown;
      this.data = markdown;
      if (assets.length) {
        // Re-open so the new images resolve.
        this.setArchive(bytes, await MdzArchiveCore.open(new Uint8Array(bytes)));
      } else {
        this.archiveBytes = bytes;
        this.savedDocs.set(doc, markdown);
      }
    } catch (err) {
      new Notice(`Saving ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Run `task` after every earlier queued archive operation has finished. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(async () => {
      this.mdzSaving = true;
      try {
        await task();
      } finally {
        this.mdzSaving = false;
      }
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  // ---- Pasting / dropping images ----

  /**
   * Store pasted or dropped images inside the archive (next to the current
   * document, under `images/`) and link them with standard Markdown image
   * syntax, matching the MDZip editor's paste behavior.
   *
   * The link is inserted immediately; the image and the updated Markdown are
   * then written to the archive together.
   */
  private async insertImages(
    files: File[],
    editor: Editor,
    source: 'paste' | 'drop',
    evt?: DragEvent
  ): Promise<void> {
    const file = this.file;
    const archive = this.archive;
    if (!file || !archive || !this.archiveBytes) {
      new Notice("Can't add images: this .mdz file didn't load.");
      return;
    }

    // Where the images go, taken now: the size and alignment dialog may move focus.
    const dropOffset = evt ? dropPosition(editor, evt) : null;
    const from = dropOffset !== null ? editor.offsetToPos(dropOffset) : editor.getCursor('from');
    const to = dropOffset !== null ? from : editor.getCursor('to');

    const baseDir = this.currentDoc.includes('/')
      ? this.currentDoc.slice(0, this.currentDoc.lastIndexOf('/') + 1)
      : '';
    const taken = new Set<string>();
    const assets: ArchiveAsset[] = [];
    const links: string[] = [];
    for (const image of files) {
      const ext = imageExtension(image);
      const stem =
        source === 'paste' ? `pasted-${Date.now()}` : safeFileStem(image.name) || `dropped-${Date.now()}`;
      let relPath = `images/${stem}.${ext}`;
      for (let n = 1; taken.has(relPath.toLowerCase()) || archive.findEntry(baseDir + relPath); n++) {
        relPath = `images/${stem}-${n}.${ext}`;
      }
      const alt = source === 'paste' ? 'Pasted image' : stem;
      const markup = await imageMarkup(this.app, this.imageMode(), relPath, image, alt);
      if (markup === null) continue; // Cancelled in the dialog: leave this image out.
      taken.add(relPath.toLowerCase());
      assets.push({ path: baseDir + relPath, bytes: new Uint8Array(await image.arrayBuffer()) });
      links.push(markup);
    }
    if (this.file !== file || !links.length) return;

    const { before, after } = blockPadding(editor, from, to);
    const separator = before || after ? '\n\n' : '\n';
    const inserted = before + links.join(separator) + after;
    editor.replaceRange(inserted, from, to);
    editor.setCursor(editor.offsetToPos(editor.posToOffset(from) + inserted.length));

    await this.enqueue(() => this.writeArchive(file, assets));
  }

  // ---- Public accessors ----

  /** Returns the current Markdown text held by the view. */
  getMarkdownContent(): string {
    return this.getViewData();
  }

  /** Archive path of the document being edited. */
  getCurrentDocument(): string {
    return this.currentDoc;
  }

  /** Archive path of the archive's entry point. */
  getEntryPoint(): string {
    return this.entryPointPath;
  }

  /** The archive's interpretation mode (spec Section 5.7). */
  getArchiveMode(): 'document' | 'project' {
    return this.isProject ? 'project' : 'document';
  }

  /** Increases whenever the archive's contents change (load, save, reload from disk). */
  getArchiveGeneration(): number {
    return this.archiveGeneration;
  }

  /** Every entry of the archive, for the contents pane. */
  listArchiveEntries(): { path: string; isMarkdown: boolean; isImage: boolean; isDirectory: boolean; size?: number }[] {
    return this.archive ? this.archive.listEntries() : [];
  }

  /** Text of an archive entry (including unsaved edits to documents), or null. */
  readArchiveText(path: string): Promise<string | null> {
    return this.readDoc(path);
  }

  /**
   * Change the archive through this view's write queue, so it can't race the
   * view's own saves: the current document's edits are saved first, then
   * `change` gets the archive bytes and returns the new bytes, which are
   * written to the file and reloaded here.
   */
  async modifyArchive(change: (bytes: ArrayBuffer) => Promise<ArrayBuffer>): Promise<void> {
    const file = this.file;
    if (!file) throw new Error('No archive is open.');
    let failure: unknown = null;
    await this.enqueue(async () => {
      if (this.file !== file) return;
      await this.writeArchive(file, []);
      if (!this.archiveBytes) {
        failure = new Error(`${file.name} couldn't be read.`);
        return;
      }
      try {
        const bytes = await change(this.archiveBytes);
        const opened = await openArchive(bytes);
        await this.app.vault.modifyBinary(file, bytes);
        this.isProject = opened.mode === 'project';
        this.entryPointPath = opened.entryPointPath;
        this.setArchive(bytes, opened.archive);
        this.updateDocumentUi();
      } catch (err) {
        failure = err;
      }
    });
    if (failure) throw failure;
  }

  /** Blob URL for an image entry, or null. The caller revokes it when done. */
  archiveImageUrl(path: string): Promise<string | null> {
    return this.archive ? readImage(this.archive, path) : Promise.resolve(null);
  }

  // ---- Archive images ----

  /**
   * Swap the archive (or clear it). Image blob URLs belong to the previous
   * archive bytes, so they're revoked and re-resolved.
   */
  private setArchive(bytes: ArrayBuffer | null, archive: MdzArchiveCore | null): void {
    this.archiveBytes = bytes;
    this.archive = archive;
    this.savedDocs.clear();
    for (const pending of this.imageUrls.values()) {
      void pending.then((url) => url?.startsWith('blob:') && URL.revokeObjectURL(url));
    }
    this.imageUrls.clear();
    this.archiveGeneration++;
    this.scheduleImageResolve();
    this.app.workspace.trigger('mdzip:archive-changed', this);
  }

  private scheduleImageResolve(): void {
    if (this.resolveScheduled) return;
    this.resolveScheduled = true;
    window.setTimeout(() => {
      this.resolveScheduled = false;
      void this.resolveImages();
    }, 0);
  }

  /**
   * Obsidian renders image links it can't find in the vault as
   * `.internal-embed.mod-empty-attachment[src]` (both live preview and
   * reading view). Raw HTML `<img>` tags keep their relative `src`. Point
   * both at the image inside the archive.
   */
  private async resolveImages(): Promise<void> {
    const archive = this.archive;
    if (!archive) return;
    const generation = String(this.archiveGeneration);

    // Obsidian resolves links against the vault, so it fades links to
    // documents in the archive, or outside it, as unresolved. Un-fade the
    // ones that do resolve (see followArchiveLinks in main.ts).
    for (const a of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>('a.internal-link.is-unresolved[data-href]')
    )) {
      if (a.getAttribute('data-mdz-link-gen') === generation) continue;
      a.setAttribute('data-mdz-link-gen', generation);
      const target = await this.resolveLink(a.getAttribute('data-href') ?? '');
      if (archive !== this.archive) return;
      if (target.kind !== 'unresolved') a.removeClass('is-unresolved');
    }

    // Claim new candidates, remembering the path they referenced.
    this.contentEl
      .querySelectorAll<HTMLElement>('.internal-embed.mod-empty-attachment[src]:not([data-mdz-src])')
      .forEach((el) => el.setAttribute('data-mdz-src', el.getAttribute('src') ?? ''));
    this.contentEl.querySelectorAll<HTMLImageElement>('img[src]:not([data-mdz-src])').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) {
        img.setAttribute('data-mdz-src', src);
      }
    });

    // Point every claimed element at the current archive (new ones, and
    // ones whose blob URLs belonged to a previous archive).
    const pending = this.contentEl.querySelectorAll<HTMLElement>(
      '[data-mdz-src]:not(img.mdz-embed-img)'
    );
    for (const el of Array.from(pending)) {
      if (el.getAttribute('data-mdz-gen') === generation) continue;
      const url = await this.imageUrl(archive, el.getAttribute('data-mdz-src') ?? '');
      // The archive changed while reading; the new archive's pass takes over.
      if (archive !== this.archive) return;
      el.setAttribute('data-mdz-gen', generation);
      if (!url) continue;
      if (el instanceof HTMLImageElement) {
        el.setAttribute('src', url);
        continue;
      }
      let img = el.querySelector<HTMLImageElement>('img.mdz-embed-img');
      if (!img) {
        el.empty();
        el.removeClass('file-embed', 'mod-empty-attachment');
        el.addClass('image-embed', 'mdz-image-embed');
        img = el.createEl('img', { cls: 'mdz-embed-img', attr: { alt: el.getAttribute('alt') ?? '' } });
      }
      img.setAttribute('src', url);
    }
  }

  /**
   * URL for an image referenced from the current document, or null: a blob
   * URL for an image inside the archive, or — only when the "Show vault
   * images linked from archives" setting is on — the vault resource URL for
   * one next to the archive (`../logo.png`, spec Sections 9.4 and 9.6).
   * Images inside other archives aren't loaded.
   */
  private imageUrl(archive: MdzArchiveCore, src: string): Promise<string | null> {
    // Only read from the current archive, so every URL lands in the cache
    // and is revoked when the archive changes.
    if (archive !== this.archive) return Promise.resolve(null);
    const ref = src.split('|')[0];
    const key = `${this.currentDoc}\u0000${ref}`;
    let pending = this.imageUrls.get(key);
    if (!pending) {
      pending = this.resolveLink(ref, 'embed').then((target) => {
        if (target.kind === 'internal') return readImage(archive, target.entry);
        if (target.kind === 'host') {
          const file = this.links.vaultFile(target.path);
          const isImage = file && MdzArchiveCore.IMAGE_MIME_TYPES[file.extension.toLowerCase()];
          return isImage ? this.app.vault.getResourcePath(file) : null;
        }
        return null;
      });
      this.imageUrls.set(key, pending);
    }
    return pending;
  }

  // ---- Errors ----

  private showError(message: string): void {
    this.clearError();
    this.errorEl = this.contentEl.createDiv({ cls: 'mdz-error' });
    this.errorEl.createEl('p', { text: `Can't open this .mdz file: ${message}` });
    this.errorEl.createEl('p', { text: 'Changes made here will not be saved.' });
    this.contentEl.prepend(this.errorEl);
  }

  private clearError(): void {
    this.errorEl?.remove();
    this.errorEl = null;
  }
}

// TextFileView internals this view relies on (present at runtime, not in
// obsidian.d.ts).
declare module 'obsidian' {
  interface TextFileView {
    dirty: boolean;
  }
}

/** Fuzzy picker over the Markdown documents of an archive. */
class DocumentPicker extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private documents: string[],
    private onPick: (path: string, evt: MouseEvent | KeyboardEvent) => void
  ) {
    super(app);
    this.setPlaceholder('Open a document in this archive…');
    this.setInstructions([
      { command: '↵', purpose: 'to open' },
      { command: 'Ctrl/⌘ ↵', purpose: 'to open in a new tab' },
    ]);
  }

  getItems(): string[] {
    return this.documents;
  }

  getItemText(path: string): string {
    return path;
  }

  onChooseItem(path: string, evt: MouseEvent | KeyboardEvent): void {
    this.onPick(path, evt);
  }
}

/** Ctrl/⌘ opens in a new tab, matching Obsidian's link behavior. */
function modPaneType(evt: MouseEvent | KeyboardEvent): PaneType | false {
  return evt.ctrlKey || evt.metaKey ? 'tab' : false;
}

interface OpenedArchive {
  archive: MdzArchiveCore;
  mode: 'document' | 'project';
  entryPointPath: string;
}

/** Open an archive and find its mode and entry point. */
export async function openArchive(bytes: ArrayBuffer): Promise<OpenedArchive> {
  const archive = await MdzArchiveCore.open(new Uint8Array(bytes));
  const mode = (await archive.resolveMode()) === 'project' ? 'project' : 'document';
  let entryPointPath: string | null = null;
  try {
    entryPointPath = await archive.resolveEntryPoint();
  } catch (err) {
    if (mode === 'document') throw err;
  }
  if (!entryPointPath || !archive.findEntry(entryPointPath)) {
    // A project archive SHOULD declare an entry point; fall back to its first document.
    const first = archive.listEntries().find((e) => e.isMarkdown && !e.isDirectory);
    if (mode === 'document' || !first) {
      throw new Error(`entry point not found in archive: "${entryPointPath ?? 'index.md'}"`);
    }
    entryPointPath = first.path;
  }
  return { archive, mode, entryPointPath };
}

/** The entry-point Markdown of an archive. */
export async function readEntryMarkdown(bytes: ArrayBuffer): Promise<string> {
  const { archive, entryPointPath } = await openArchive(bytes);
  return (await readDocument(archive, entryPointPath)) ?? '';
}

/** `preferred` if it's a document in the archive, else the entry point. */
function pickDocument(archive: MdzArchiveCore, preferred: string | null, entryPointPath: string): string {
  if (preferred && MdzArchiveCore.isMarkdownFile(preferred)) {
    const entry = archive.findEntry(preferred) as ZipEntryLike | null;
    if (entry && !entry.dir) return preferred;
  }
  return entryPointPath;
}

/** Text of a document in the archive, or null if it isn't there. */
async function readDocument(archive: MdzArchiveCore, path: string): Promise<string | null> {
  const entry = archive.findEntry(path) as ZipEntryLike | null;
  if (!entry || entry.dir) return null;
  return (await entry.async('text')) as string;
}

/** Blob URL for an image entry, or null if it isn't an image in the archive. */
async function readImage(archive: MdzArchiveCore, path: string): Promise<string | null> {
  try {
    const entry = archive.findEntry(path) as ZipEntryLike | null;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = MdzArchiveCore.IMAGE_MIME_TYPES[ext];
    if (!entry || entry.dir || !mimeType) return null;
    const buffer = (await entry.async('arraybuffer')) as ArrayBuffer;
    return URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  } catch {
    return null; // Un-resolvable reference; leave Obsidian's placeholder in place.
  }
}

/** An entry to add to the archive. */
interface ArchiveAsset {
  path: string;
  bytes: Uint8Array;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer | null): boolean {
  if (!b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}
