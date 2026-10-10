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
import { MdzView, VIEW_TYPE_MDZ, readEntryMarkdown } from './mdz-view';
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
 *  - "Export note as .mdz" command – packages the active Markdown note into
 *    a new .mdz file placed alongside it in the vault.
 *
 *  - "Extract Markdown from .mdz" command – reads the entry-point Markdown
 *    out of the active .mdz view and creates a new .md file in the vault.
 */
export default class MdzPlugin extends Plugin {
  settings: MdzSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new MdzSettingTab(this.app, this));

    // Register the custom view for .mdz files
    this.registerView(VIEW_TYPE_MDZ, (leaf) => new MdzView(leaf));

    // Tell Obsidian to open .mdz files with this plugin's view
    this.registerExtensions(['mdz'], VIEW_TYPE_MDZ);

    // .mdz files are binary: text reads get the document's Markdown, and
    // text writes (e.g. from Obsidian's plain Markdown view) are refused.
    // Installed first so it also covers the tab repair below.
    this.guardMdzTextAccess();

    // Keep .mdz tabs in the MDZip view when Obsidian switches Markdown modes
    this.redirectMarkdownViewState();

    // Links from a .mdz to documents inside the same archive open there
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
      if (convert) await convertNoteToMdz(this.app, view, files, source, target);
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
   * up in the vault and, if it isn't there, creates a new note. For links
   * from a .mdz whose target is a document inside the same archive, open
   * that document in the MDZip view instead. Other links behave as usual.
   */
  private followArchiveLinks(): void {
    const proto = WorkspaceLeaf.prototype;
    const original = proto.openLinkText;
    const findView = (leaf: WorkspaceLeaf, sourcePath: string): MdzView | null => {
      const candidates = [leaf.view, this.app.workspace.getActiveViewOfType(MdzView)];
      this.app.workspace.getLeavesOfType(VIEW_TYPE_MDZ).forEach((l) => candidates.push(l.view));
      for (const view of candidates) {
        if (view instanceof MdzView && view.file?.path === sourcePath) return view;
      }
      return null;
    };
    const patched = async function (
      this: WorkspaceLeaf,
      linktext: string,
      sourcePath: string,
      openViewState?: OpenViewState
    ): Promise<void> {
      if (/\.mdz$/i.test(sourcePath)) {
        const source = findView(this, sourcePath);
        const { path, subpath } = parseLinktext(linktext);
        const target = source?.resolveDocumentLink(path);
        if (source && target) {
          const base = this.view === source ? source.getState() : { file: sourcePath, mode: source.getMode() };
          await this.setViewState(
            { type: VIEW_TYPE_MDZ, state: { ...base, mdzDoc: target }, active: openViewState?.active ?? true },
            { ...(openViewState?.eState ?? {}), ...(subpath ? { subpath } : {}) }
          );
          return;
        }
      }
      return original.call(this, linktext, sourcePath, openViewState);
    };
    proto.openLinkText = patched;
    this.register(() => {
      if (proto.openLinkText === patched) proto.openLinkText = original;
    });
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
