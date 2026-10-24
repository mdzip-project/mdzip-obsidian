import {
  Editor,
  MarkdownView,
  Notice,
  OpenViewState,
  parseLinktext,
  Plugin,
  TFile,
  ViewState,
  WorkspaceLeaf,
} from 'obsidian';
import { MdzPackagerCore } from '@mdzip/core-js';
import { MdzView, VIEW_TYPE_MDZ, openArchive, readEntryMarkdown } from './mdz-view';
import { isBareName, LinkTarget, mentionsArchive } from './links';
import { ArchiveIndex, indexOf, VaultLinks } from './vault-links';
import { ArchiveCatalog, nodeId } from './archive-catalog';
import { GraphIntegration } from './graph';
import { MdzSearchView, VIEW_TYPE_MDZ_SEARCH } from './search-view';
import { buildLinkIndex } from './link-index';
import { MdzLinksView, VIEW_TYPE_MDZ_LINKS } from './links-view';
import { MdzContentsView, VIEW_TYPE_MDZ_CONTENTS } from './contents-view';
import { addSupportFile, type SupportFileKind } from './support-files';
import { archiveActions, type ArchiveActions } from './archive-actions';
import { imageMarkup } from './image-insert-modal';
import { ConvertNoteModal, convertNoteToMdz, InsertTarget, pasteIntoVault } from './convert';
import { dropPosition, imageFiles } from './images';
import { DEFAULT_SETTINGS, MdzSettings, MdzSettingTab } from './settings';

/**
 * MDZip Obsidian Plugin
 *
 * Registers `.mdz` as a first-class file type in Obsidian and provides:
 *
 *  - A view ({@link MdzView}) that opens .mdz archives in Obsidian's own
 *    Markdown editor and saves edits back into the archive. Project-mode
 *    archives open on their entry point; links between their documents, and
 *    the "Open document in archive" command, open other documents.
 *
 *  - Images pasted or dropped into a regular Markdown note can convert the
 *    note into a .mdz, so the images live inside it (asked each time, or
 *    always/never per the plugin setting). "Convert note to .mdz" does the
 *    same without an image.
 *
 *  - Archive documents in Obsidian's graph and local graph (nodes and links
 *    added to the graph views' data), and an "MDZip search" view that
 *    searches inside every archive, since Obsidian's own index only covers
 *    .md files.
 *
 *  - An "Archive links" panel listing incoming and outgoing links for archive
 *    documents, and archive documents that link to a regular note.
 *
 *  - "Export note as .mdz" command – packages the active Markdown note into
 *    a new .mdz file placed alongside it in the vault.
 *
 *  - "Extract Markdown from .mdz" command – reads the entry-point Markdown
 *    out of the active .mdz view and creates a new .md file in the vault.
 */
export default class MdzPlugin extends Plugin {
  settings: MdzSettings = { ...DEFAULT_SETTINGS };
  links!: VaultLinks;
  catalog!: ArchiveCatalog;
  graph!: GraphIntegration;
  actions!: ArchiveActions;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new MdzSettingTab(this.app, this));

    // Link resolution between the vault and archives (spec Sections 9.3–9.6)
    this.links = new VaultLinks(
      this.app,
      (path) => this.openArchiveIndex(path),
      async (bytes) => {
        const { archive, entryPointPath } = await openArchive(bytes);
        const entries = archive
          .listEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => e.path);
        return indexOf(entries, entryPointPath);
      },
      () => this.settings.outsideImages
    );

    // Register the custom view for .mdz files
    this.registerView(VIEW_TYPE_MDZ, (leaf) => new MdzView(leaf, this.links, () => this.settings.archiveImages));

    // Archive documents in the graph, and search inside archives
    this.catalog = new ArchiveCatalog(this.app, this.links);
    this.graph = new GraphIntegration(this.app, this.catalog, (localFile) => this.graphFocus(localFile));
    this.register(
      this.catalog.onChange(() => {
        void this.graph.refresh();
        this.refreshLinksViews();
      })
    );
    this.register(() => this.graph.unhookAll());
    this.registerArchiveIndexing();
    this.registerView(VIEW_TYPE_MDZ_SEARCH, (leaf) => new MdzSearchView(leaf, this.catalog));
    this.addRibbonIcon('package-search', 'Search MDZip archives', () => void this.openSearch());
    this.registerView(VIEW_TYPE_MDZ_LINKS, (leaf) => new MdzLinksView(leaf, () => this.linkIndex()));
    this.actions = archiveActions(this.app, (file, kind) => addSupportFile(this.app, file, kind));
    this.registerView(VIEW_TYPE_MDZ_CONTENTS, (leaf) => new MdzContentsView(leaf, this.actions));
    this.registerArchiveCommands();
    for (const kind of ['README', 'AGENTS'] as SupportFileKind[]) {
      this.addCommand({
        id: `add-${kind.toLowerCase()}`,
        name: `Add ${kind}.md to the archive`,
        checkCallback: (checking: boolean) => {
          const file = this.activeMdzView()?.file;
          if (!file) return false;
          if (!checking) void addSupportFile(this.app, file, kind);
          return true;
        },
      });
    }

    // File menu (right-click in Files, and a tab's "More options"): archive
    // actions for .mdz files, and Convert to MDZip for notes.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile)) return;
        const ext = file.extension.toLowerCase();
        if (ext === 'mdz') {
          menu.addItem((item) =>
            item
              .setSection('action')
              .setTitle('New document in archive')
              .setIcon('file-plus')
              .onClick(() => void this.actions.newDocument(file))
          );
          for (const kind of ['README', 'AGENTS'] as SupportFileKind[]) {
            menu.addItem((item) =>
              item
                .setSection('action')
                .setTitle(`Add ${kind}.md`)
                .setIcon(kind === 'README' ? 'book-open' : 'bot')
                .onClick(() => void addSupportFile(this.app, file, kind))
            );
          }
        } else if (ext === 'md') {
          menu.addItem((item) =>
            item
              .setSection('action')
              .setTitle('Convert to MDZip')
              .setIcon('package')
              .onClick(() => void this.convertFile(file))
          );
        }
      })
    );
    this.addCommand({
      id: 'show-contents',
      name: 'Show archive contents',
      callback: () => void this.openContentsPanel(),
    });
    this.addCommand({
      id: 'show-links',
      name: 'Show links for the current document',
      callback: () => void this.openLinksPanel(),
    });
    this.addCommand({
      id: 'search-archives',
      name: 'Search inside .mdz files',
      callback: () => void this.openSearch(),
    });

    // Tell Obsidian to open .mdz files with this plugin's view
    this.registerExtensions(['mdz'], VIEW_TYPE_MDZ);

    // .mdz files are binary: text reads get the document's Markdown, and
    // text writes (e.g. from Obsidian's plain Markdown view) are refused.
    // Installed first so it also covers the tab repair below.
    this.guardMdzTextAccess();

    // Keep .mdz tabs in the MDZip view when Obsidian switches Markdown modes
    this.redirectMarkdownViewState();

    // Links inside archives, out of them to vault files, and into them from notes
    this.followArchiveLinks();

    // Images pasted/dropped into Markdown notes: offer to convert the note
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor, info) => {
        const files = imageFiles(evt.clipboardData);
        if (!evt.defaultPrevented && this.takesMarkdownImages(info, files)) {
          evt.preventDefault();
          void this.handleMarkdownImages(info as MarkdownView, editor, files, 'paste', {
            from: editor.getCursor('from'),
            to: editor.getCursor('to'),
          });
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, info) => {
        const files = imageFiles(evt.dataTransfer);
        if (!evt.defaultPrevented && this.takesMarkdownImages(info, files)) {
          evt.preventDefault();
          const offset = dropPosition(editor, evt);
          const pos = offset !== null ? editor.offsetToPos(offset) : editor.getCursor();
          void this.handleMarkdownImages(info as MarkdownView, editor, files, 'drop', { from: pos, to: pos });
        }
      })
    );

    // Command: convert the active Markdown note into a .mdz
    this.addCommand({
      id: 'convert-note-to-mdz',
      name: 'Convert note to .mdz',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && !(view instanceof MdzView) && view.file?.extension === 'md') {
          if (!checking) void convertNoteToMdz(this.app, view);
          return true;
        }
        return false;
      },
    });

    // Command: pick a document of the active archive to open
    this.addCommand({
      id: 'open-document-in-archive',
      name: 'Open document in archive',
      checkCallback: (checking: boolean) => {
        const view = this.activeMdzView();
        if (view && view.listDocuments().length > 1) {
          if (!checking) view.chooseDocument();
          return true;
        }
        return false;
      },
    });

    // Command: export the active Markdown note as a .mdz archive
    this.addCommand({
      id: 'export-note-as-mdz',
      name: 'Export note as .mdz',
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
          if (!checking) {
            this.exportNoteAsMdz(activeFile);
          }
          return true;
        }
        return false;
      },
    });

    // Command: extract entry-point Markdown from the active .mdz view
    this.addCommand({
      id: 'extract-markdown-from-mdz',
      name: 'Extract Markdown from .mdz',
      checkCallback: (checking: boolean) => {
        const view = this.activeMdzView();
        if (view) {
          if (!checking) {
            this.extractMarkdownFromView(view);
          }
          return true;
        }
        return false;
      },
    });
  }

  onunload(): void {}

  /** Commands that change the active archive, or the document open in it. */
  private registerArchiveCommands(): void {
    const onArchive = (id: string, name: string, run: (file: TFile, doc: string) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          const view = this.activeMdzView();
          if (!view?.file) return false;
          if (!checking) run(view.file, view.getCurrentDocument());
          return true;
        },
      });
    onArchive('new-document', 'New document in archive', (file) => void this.actions.newDocument(file));
    onArchive('new-folder', 'New folder in archive', (file) => void this.actions.newFolder(file));
    onArchive('rename-document', 'Rename current document in archive', (file, doc) => void this.actions.rename(file, doc, false));
    onArchive('move-document', 'Move current document to another folder in archive', (file, doc) =>
      void this.actions.moveTo(file, doc, false)
    );
    onArchive('make-entry-point', 'Make current document the entry point', (file, doc) => void this.actions.setEntryPoint(file, doc));
    onArchive('delete-document', 'Delete current document from archive', (file, doc) => void this.actions.remove(file, doc, false));
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** True when this plugin should handle images coming into a regular Markdown note. */
  private takesMarkdownImages(info: unknown, files: File[]): boolean {
    return (
      files.length > 0 &&
      this.settings.markdownPaste !== 'vault' &&
      info instanceof MarkdownView &&
      !(info instanceof MdzView) &&
      info.file?.extension === 'md'
    );
  }

  /** Convert the note to .mdz with the images, or save them to the vault as usual. */
  private async handleMarkdownImages(
    view: MarkdownView,
    editor: Editor,
    files: File[],
    source: 'paste' | 'drop',
    target: InsertTarget
  ): Promise<void> {
    const file = view.file;
    if (!file) return;
    const act = async (convert: boolean) => {
      if (convert) {
        await convertNoteToMdz(this.app, view, files, source, target, (path, image, alt) =>
          imageMarkup(this.app, this.settings.archiveImages, path, image, alt)
        );
      }
      else await pasteIntoVault(this.app, file, editor, files, source, target);
    };
    if (this.settings.markdownPaste === 'convert') {
      await act(true);
      return;
    }
    new ConvertNoteModal(this.app, file.name, (convert, remember) => {
      if (remember) {
        this.settings.markdownPaste = convert ? 'convert' : 'vault';
        void this.saveSettings();
      }
      void act(convert);
    }).open();
  }

  /**
   * Make Obsidian's text-file APIs safe for .mdz archives:
   *
   *  - `read` / `cachedRead` return the entry-point Markdown instead of the
   *    zip bytes decoded as text, so anything that reads a .mdz as a text
   *    file (e.g. the word count on file open) sees the document.
   *  - `modify` / `append` / `process` are refused. This plugin only ever
   *    writes archives with `modifyBinary`; a text write to a .mdz can only
   *    come from something that read the zip as text, and would corrupt it.
   */
  private guardMdzTextAccess(): void {
    const vault = this.app.vault;
    const isMdz = (file: TFile) => file.extension.toLowerCase() === 'mdz';
    const refuse = (file: TFile) =>
      console.warn(`MDZip: blocked a text write to ${file.path} (.mdz files are binary archives).`);
    const readMarkdown = async (file: TFile) => readEntryMarkdown(await vault.readBinary(file));

    const { read, cachedRead, modify, append, process } = vault;
    vault.read = function (file) {
      if (isMdz(file)) return readMarkdown(file).catch(() => '');
      return read.call(this, file);
    };
    vault.cachedRead = function (file) {
      if (isMdz(file)) return readMarkdown(file).catch(() => '');
      return cachedRead.call(this, file);
    };
    vault.modify = function (file, data, options) {
      if (isMdz(file)) return Promise.resolve(refuse(file));
      return modify.call(this, file, data, options);
    };
    vault.append = function (file, data, options) {
      if (isMdz(file)) return Promise.resolve(refuse(file));
      return append.call(this, file, data, options);
    };
    vault.process = function (file, fn, options) {
      if (isMdz(file)) {
        refuse(file);
        return Promise.reject(new Error(`${file.path} is a binary .mdz archive`));
      }
      return process.call(this, file, fn, options);
    };
    this.register(() => {
      vault.read = read;
      vault.cachedRead = cachedRead;
      vault.modify = modify;
      vault.append = append;
      vault.process = process;
    });
  }

  /**
   * MDZip's view is Obsidian's MarkdownView, and MarkdownView switches
   * modes (reading/editing toggle, source mode, backlinks, the pane menu,
   * the status-bar mode picker) by calling `leaf.setViewState` with a
   * hard-coded `type: "markdown"`. For a .mdz tab that would replace this
   * view with the plain-text Markdown view, which shows (and could save) the
   * raw zip bytes. Rewrite those calls to the MDZip view type, and repair any
   * .mdz tab already saved in the workspace as a plain Markdown view.
   */
  private redirectMarkdownViewState(): void {
    const proto = WorkspaceLeaf.prototype;
    const original = proto.setViewState;
    const patched = function (this: WorkspaceLeaf, viewState: ViewState, eState?: unknown) {
      return original.call(this, toMdzViewState(viewState), eState);
    };
    proto.setViewState = patched;
    this.register(() => {
      if (proto.setViewState === patched) proto.setViewState = original;
    });

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const viewState = leaf.getViewState();
        if (toMdzViewState(viewState) !== viewState) {
          void leaf.setViewState(viewState);
        }
      });
    });
  }

  /**
   * Obsidian resolves link clicks (reading view, live preview, Ctrl-click,
   * wikilinks) through `WorkspaceLeaf.openLinkText`, which looks the target
   * up in the vault and, if it isn't there, creates a new note. That gets
   * archive links wrong: Obsidian treats a `.mdz` as a file, not a
   * directory, so links out of an archive land one level too high, and links
   * into one (`Project.mdz/docs/a.md`) create a stray note. Resolve these
   * links with the spec's rules (Sections 9.3–9.5) first:
   *
   *  - from a document inside an archive: every link except external URLs;
   *  - from a regular note: links that name an `.mdz` archive.
   *
   * Bare names (`[[Notes]]`) that don't match anything in the archive keep
   * Obsidian's vault-wide name lookup. openLinkText doesn't say whether a
   * link was a wikilink or a Markdown link, so this also covers single-name
   * Markdown links (`[Notes](Notes.md)`), matching how Obsidian treats them
   * elsewhere; strictly, the spec (Section 9.3) would leave those unresolved.
   * Any other link that doesn't resolve shows a notice instead of creating a
   * note.
   */
  private followArchiveLinks(): void {
    const proto = WorkspaceLeaf.prototype;
    const original = proto.openLinkText;
    const plugin = this;
    const patched = async function (
      this: WorkspaceLeaf,
      linktext: string,
      sourcePath: string,
      openViewState?: OpenViewState
    ): Promise<void> {
      if (await plugin.openArchiveLink(this, linktext, sourcePath, openViewState)) return;
      return original.call(this, linktext, sourcePath, openViewState);
    };
    proto.openLinkText = patched;
    this.register(() => {
      if (proto.openLinkText === patched) proto.openLinkText = original;
    });
  }

  /** Open `linktext` in `leaf` if it's an archive link; false to let Obsidian handle it. */
  private async openArchiveLink(
    leaf: WorkspaceLeaf,
    linktext: string,
    sourcePath: string,
    openViewState?: OpenViewState
  ): Promise<boolean> {
    const { path, subpath } = parseLinktext(linktext);
    const fromArchive = /\.mdz$/i.test(sourcePath);
    let target: LinkTarget;

    if (fromArchive) {
      const source = this.findMdzView(leaf, sourcePath);
      if (!source) return false;
      target = await source.resolveLink(path);
    } else {
      if (!mentionsArchive(path)) return false;
      target = await this.links.resolve({ host: sourcePath }, path);
      if (target.kind === 'unresolved') {
        // Obsidian-style vault-absolute or shortest-name links to the archive.
        target = (await this.links.resolveByName(sourcePath, path)) ?? target;
      }
    }

    const eState = { ...(openViewState?.eState ?? {}), ...(subpath ? { subpath } : {}) };
    const active = openViewState?.active ?? true;
    switch (target.kind) {
      case 'url':
        return false;
      case 'internal':
        await this.openInArchive(leaf, sourcePath, target.entry, active, eState);
        return true;
      case 'archive':
        await this.openInArchive(leaf, target.archive, target.entry, active, eState);
        return true;
      case 'host': {
        const file = this.links.vaultFile(target.path);
        if (!file) return false;
        await leaf.openFile(file, { ...openViewState, active, eState });
        return true;
      }
      case 'unresolved':
        if (fromArchive && isBareName(path) && this.app.metadataCache.getFirstLinkpathDest(path, sourcePath)) {
          return false;
        }
        new Notice(unresolvedMessage(path, target.reason));
        return true;
    }
  }

  /** Show `entry` of the archive at `archivePath` in `leaf`, keeping its mode when it's already that archive. */
  private async openInArchive(
    leaf: WorkspaceLeaf,
    archivePath: string,
    entry: string,
    active: boolean,
    eState: Record<string, unknown>
  ): Promise<void> {
    const view = leaf.view;
    const base = view instanceof MdzView && view.file?.path === archivePath ? view.getState() : { file: archivePath };
    await leaf.setViewState({ type: VIEW_TYPE_MDZ, state: { ...base, mdzDoc: entry }, active }, eState);
  }

  /** The MdzView showing `sourcePath`: preferably in `leaf`, then the active one, then any. */
  private findMdzView(leaf: WorkspaceLeaf, sourcePath: string): MdzView | null {
    const candidates = [leaf.view, this.app.workspace.getActiveViewOfType(MdzView)];
    this.app.workspace.getLeavesOfType(VIEW_TYPE_MDZ).forEach((l) => candidates.push(l.view));
    for (const view of candidates) {
      if (view instanceof MdzView && view.file?.path === sourcePath) return view;
    }
    return null;
  }

  /** Keep the archive catalog and graph hooks current as the vault and workspace change. */
  private registerArchiveIndexing(): void {
    const { vault, metadataCache, workspace } = this.app;
    this.registerEvent(vault.on('create', (f) => this.catalog.onFileChanged(f)));
    this.registerEvent(vault.on('modify', (f) => this.catalog.onFileChanged(f)));
    this.registerEvent(vault.on('delete', (f) => this.catalog.onFileDeleted(f)));
    this.registerEvent(vault.on('rename', (f, oldPath) => this.catalog.onFileRenamed(f, oldPath)));
    this.registerEvent(metadataCache.on('changed', (f, _data, cache) => void this.catalog.onMetadataChanged(f, cache)));
    this.registerEvent(workspace.on('layout-change', () => this.graph.hookAll()));
    this.registerEvent(workspace.on('active-leaf-change', () => this.graph.hookAll(true)));
    // Custom event from MdzView when it switches documents within an archive.
    this.registerEvent(
      (workspace as unknown as { on(name: string, cb: () => void): ReturnType<typeof workspace.on> }).on(
        'mdzip:document-open',
        () => this.graph.hookAll(true)
      )
    );
    workspace.onLayoutReady(() => {
      void this.catalog.build().then(() => this.graph.refresh());
    });
  }

  /**
   * Graph node to focus: the document open in the active MDZip view, when
   * the graph is global or local to that archive.
   */
  private graphFocus(localFile: string | null): string | null {
    const view = this.app.workspace.getActiveViewOfType(MdzView);
    const path = view?.file?.path;
    if (!view || !path || (localFile !== null && localFile !== path)) return null;
    return nodeId(path, view.getCurrentDocument(), view.getEntryPoint());
  }

  /** Current incoming/outgoing links between archive documents and notes. */
  private async linkIndex() {
    return buildLinkIndex(
      await this.catalog.summaries(),
      this.catalog.noteToArchiveLinks(),
      this.app.metadataCache.resolvedLinks
    );
  }

  private refreshLinksViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MDZ_LINKS)) {
      if (leaf.view instanceof MdzLinksView) leaf.view.refresh();
    }
  }

  /** Show the Archive links panel in the right sidebar. */
  /** Convert a note to .mdz, opening it first if it isn't open (Convert to MDZip in the file menu). */
  private async convertFile(file: TFile): Promise<void> {
    let view: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!view && leaf.view instanceof MarkdownView && !(leaf.view instanceof MdzView) && leaf.view.file === file) {
        view = leaf.view;
      }
    });
    if (!view) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      view = leaf.view instanceof MarkdownView ? leaf.view : null;
    }
    if (view) await convertNoteToMdz(this.app, view);
  }

  /**
   * Show the archive contents pane in the left sidebar, in its own section
   * below the file explorer (not as another tab beside it, which would hide
   * the file explorer). Once the user moves it, it stays where they put it.
   */
  async openContentsPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MDZ_CONTENTS)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(true) ?? workspace.getLeaf('split');
      await leaf.setViewState({ type: VIEW_TYPE_MDZ_CONTENTS, active: false });
    }
    await workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred();
  }

  async openLinksPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MDZ_LINKS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('split');
      await leaf.setViewState({ type: VIEW_TYPE_MDZ_LINKS, active: false });
    }
    await workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred();
  }

  /** Show the MDZip search view in the left sidebar and focus its query box. */
  private async openSearch(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MDZ_SEARCH)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_MDZ_SEARCH, active: true });
    }
    await workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred();
    const selection = workspace.activeEditor?.editor?.getSelection()?.trim();
    if (leaf.view instanceof MdzSearchView) leaf.view.focusQuery(selection || undefined);
  }

  /** The live entry index of an archive that's open in a view, if any. */
  private openArchiveIndex(path: string): ArchiveIndex | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MDZ)) {
      const view = leaf.view;
      if (view instanceof MdzView && view.file?.path === path) {
        const index = view.archiveIndex();
        if (index) return index;
      }
    }
    return null;
  }

  // ---- Commands ----

  /**
   * Pack the content of a Markdown note into a new (or overwritten) .mdz
   * archive placed in the same vault folder.
   */
  private async exportNoteAsMdz(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const archiveName = file.basename;
      const mdzPath = file.path.replace(/\.md$/i, '.mdz');

      const result = await MdzPackagerCore.buildArchive(
        [{ path: 'index.md', text: content }],
        archiveName,
        {
          createIndex: false,
          mapFiles: false,
          filters: ['**/*.md'],
          mode: 'document',
          entryPoint: 'index.md',
          title: archiveName,
        }
      );

      const arrayBuffer = await result.blob.arrayBuffer();
      const existing = this.app.vault.getAbstractFileByPath(mdzPath);

      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, arrayBuffer);
        new Notice(`MDZip updated: ${mdzPath}`);
      } else {
        await this.app.vault.createBinary(mdzPath, arrayBuffer);
        new Notice(`MDZip created: ${mdzPath}`);
      }
    } catch (err) {
      new Notice(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Read the entry-point Markdown from the currently active {@link MdzView}
   * and write it as a new .md file in the vault (alongside the .mdz).
   */
  private async extractMarkdownFromView(view: MdzView): Promise<void> {
    const file = view.file;
    if (!file) {
      new Notice('No .mdz file is open.');
      return;
    }

    try {
      const mdContent = view.getMarkdownContent();
      // In a project archive, name the note after the document too.
      const docStem = (view.getCurrentDocument().split('/').pop() ?? '').replace(/\.[^.]*$/, '');
      const suffix = view.listDocuments().length > 1 && docStem !== 'index' ? ` - ${docStem}` : '';
      const mdPath = file.path.replace(/\.mdz$/i, `${suffix}.extracted.md`);

      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, mdContent);
        new Notice(`Markdown updated: ${mdPath}`);
      } else {
        await this.app.vault.create(mdPath, mdContent);
        new Notice(`Markdown extracted: ${mdPath}`);
      }

      // Open the new file in a new leaf
      const leaf = this.app.workspace.getLeaf(true);
      const newFile = this.app.vault.getAbstractFileByPath(mdPath);
      if (leaf && newFile instanceof TFile) {
        await leaf.openFile(newFile);
      }
    } catch (err) {
      new Notice(
        `Extraction failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- Helpers ----

  /** Returns the {@link MdzView} in the currently active leaf, or null. */
  private activeMdzView(): MdzView | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view instanceof MdzView) {
      return activeLeaf.view;
    }
    return null;
  }
}

/** A Markdown view state for a .mdz file, retargeted at the MDZip view. */
function toMdzViewState(viewState: ViewState): ViewState {
  const file = viewState.state?.file;
  if (viewState.type === 'markdown' && typeof file === 'string' && /\.mdz$/i.test(file)) {
    return { ...viewState, type: VIEW_TYPE_MDZ };
  }
  return viewState;
}

// WorkspaceLeaf internals this plugin relies on (present at runtime, not in
// obsidian.d.ts).
declare module 'obsidian' {
  interface WorkspaceLeaf {
    openLinkText(linktext: string, sourcePath: string, openViewState?: OpenViewState): Promise<void>;
  }
}

/** Notice text for a link that doesn't resolve. */
function unresolvedMessage(link: string, reason: string): string {
  switch (reason) {
    case 'no-host-location':
      return `"${link}" points outside this archive, which has no location in the vault.`;
    case 'nested-archive':
      return `"${link}" goes into an archive inside another archive, which isn't supported.`;
    case 'invalid':
      return `"${link}" isn't a valid link path.`;
    default:
      return `Can't find "${link}".`;
  }
}
