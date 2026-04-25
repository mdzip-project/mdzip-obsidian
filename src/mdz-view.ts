import { App, FileView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { MdzArchiveCore, MdzManifest, MdzPackagerCore } from 'mdzip-core-js';

export const VIEW_TYPE_MDZ = 'mdz-document';

/** Represents a JSZip entry with the async() read method. */
interface ZipEntryLike {
  dir: boolean;
  async(kind: 'text' | 'arraybuffer' | 'base64'): Promise<string | ArrayBuffer>;
}

type ViewMode = 'preview' | 'source';

/**
 * Custom FileView for .mdz (MDZip) single-document archives.
 *
 * Supports two display modes:
 *  - preview: renders the entry-point Markdown with Obsidian's renderer,
 *    resolving archive-local images to inline data URIs.
 *  - source: exposes the raw Markdown text in an editable textarea.
 *
 * Changes made in source mode can be saved back into the .mdz archive via
 * the toolbar Save button or the standard Mod+S shortcut.
 */
export class MdzView extends FileView {
  // ---- internal state ----
  private mode: ViewMode = 'preview';
  private markdownContent = '';
  private archiveBytes: ArrayBuffer | null = null;
  private archiveManifest: MdzManifest | null = null;
  private entryPointPath = 'index.md';
  private isDirty = false;
  private isSaving = false;
  private archive: MdzArchiveCore | null = null;

  // ---- DOM elements (created in onOpen) ----
  private toolbarEl!: HTMLElement;
  private previewBtn!: HTMLButtonElement;
  private sourceBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private titleEl!: HTMLElement;
  private contentAreaEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private editorEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  // ---- Obsidian overrides ----

  getViewType(): string {
    return VIEW_TYPE_MDZ;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'MDZ Document';
  }

  getIcon(): string {
    return 'package';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mdz-view');

    this.buildToolbar();
    this.buildContent();
    this.setMode('preview', false);

    // Mod+S saves
    this.registerDomEvent(contentEl, 'keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.saveCurrentContent();
      }
    });
  }

  async onClose(): Promise<void> {
    this.archive = null;
    this.archiveBytes = null;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.clearContent();
    this.showStatus('Loading…');

    try {
      this.archiveBytes = await this.app.vault.readBinary(file);
      this.archive = await MdzArchiveCore.open(new Uint8Array(this.archiveBytes));

      const archiveMode = await this.archive.resolveMode();
      if (archiveMode === 'project') {
        this.showError(
          'Project-mode .mdz archives are not supported.\n' +
            'This plugin only supports single-document (document mode) .mdz files.'
        );
        return;
      }

      this.entryPointPath = await this.archive.resolveEntryPoint();
      this.archiveManifest = await this.archive.readManifest();

      const entry = this.archive.findEntry(this.entryPointPath) as ZipEntryLike | null;
      if (!entry) {
        throw new Error(`Entry point not found in archive: "${this.entryPointPath}"`);
      }
      this.markdownContent = (await entry.async('text')) as string;

      this.isDirty = false;
      this.updateTitle();
      this.updateSaveButton();
      await this.renderCurrentMode();
    } catch (err) {
      this.showError(
        `Failed to open .mdz file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.archive = null;
    this.archiveBytes = null;
    this.markdownContent = '';
    this.isDirty = false;
  }

  /** Re-load when the underlying file changes on disk (e.g. external edit). */
  onModify(file: TFile): void {
    if (!this.isSaving) {
      this.onLoadFile(file);
    }
  }

  // ---- Toolbar ----

  private buildToolbar(): void {
    const { contentEl } = this;
    this.toolbarEl = contentEl.createDiv({ cls: 'mdz-toolbar' });

    this.titleEl = this.toolbarEl.createDiv({ cls: 'mdz-toolbar-title' });
    this.titleEl.setText('');

    const actions = this.toolbarEl.createDiv({ cls: 'mdz-toolbar-actions' });

    this.previewBtn = actions.createEl('button', {
      cls: 'mdz-btn',
      text: 'Preview',
    });
    this.previewBtn.addEventListener('click', () => this.setMode('preview', true));

    this.sourceBtn = actions.createEl('button', {
      cls: 'mdz-btn',
      text: 'Edit',
    });
    this.sourceBtn.addEventListener('click', () => this.setMode('source', true));

    this.saveBtn = actions.createEl('button', {
      cls: 'mdz-btn mdz-btn-save',
      text: 'Save',
    });
    this.saveBtn.addEventListener('click', () => this.saveCurrentContent());
    this.saveBtn.disabled = true;
  }

  private buildContent(): void {
    const { contentEl } = this;
    this.contentAreaEl = contentEl.createDiv({ cls: 'mdz-content' });

    this.previewEl = this.contentAreaEl.createDiv({
      cls: 'mdz-preview markdown-preview-view markdown-rendered',
    });

    this.editorEl = this.contentAreaEl.createEl('textarea', {
      cls: 'mdz-editor',
    });
    this.editorEl.spellcheck = false;
    this.editorEl.addEventListener('input', () => {
      this.isDirty = true;
      this.updateSaveButton();
    });

    this.statusEl = this.contentAreaEl.createDiv({ cls: 'mdz-status' });
    this.statusEl.hide();
  }

  // ---- Mode switching ----

  private setMode(mode: ViewMode, render = true): void {
    if (mode === 'source') {
      // Sync textarea with current content before switching
      this.editorEl.value = this.markdownContent;
    } else if (this.mode === 'source') {
      // Leaving source mode: capture edits
      this.syncFromEditor();
    }

    this.mode = mode;

    if (mode === 'preview') {
      this.previewEl.show();
      this.editorEl.hide();
      this.previewBtn.addClass('mdz-btn-active');
      this.sourceBtn.removeClass('mdz-btn-active');
    } else {
      this.previewEl.hide();
      this.editorEl.show();
      this.editorEl.focus();
      this.sourceBtn.addClass('mdz-btn-active');
      this.previewBtn.removeClass('mdz-btn-active');
    }

    if (render) {
      this.renderCurrentMode();
    }
  }

  private syncFromEditor(): void {
    const newContent = this.editorEl.value;
    if (newContent !== this.markdownContent) {
      this.markdownContent = newContent;
      this.isDirty = true;
      this.updateSaveButton();
    }
  }

  // ---- Rendering ----

  private async renderCurrentMode(): Promise<void> {
    this.statusEl.hide();
    if (this.mode === 'preview') {
      await this.renderPreview();
    } else {
      this.editorEl.value = this.markdownContent;
    }
  }

  private async renderPreview(): Promise<void> {
    this.previewEl.empty();
    if (!this.markdownContent) return;

    await MarkdownRenderer.render(
      this.app,
      this.markdownContent,
      this.previewEl,
      this.file?.path ?? '',
      this
    );

    if (this.archive) {
      await this.resolvePreviewImages(this.previewEl);
    }
  }

  /**
   * Replace `<img>` src attributes that point to archive-relative paths with
   * inline data URIs, so images from inside the .mdz render correctly.
   */
  private async resolvePreviewImages(el: HTMLElement): Promise<void> {
    if (!this.archive) return;

    const imgs = el.querySelectorAll('img[src]');
    for (const img of Array.from(imgs)) {
      const src = img.getAttribute('src');
      if (
        !src ||
        src.startsWith('data:') ||
        src.startsWith('http://') ||
        src.startsWith('https://') ||
        src.startsWith('app://')
      ) {
        continue;
      }

      try {
        const resolvedPath = MdzArchiveCore.resolvePath(this.entryPointPath, src);
        const entry = this.archive.findEntry(resolvedPath) as ZipEntryLike | null;
        if (entry && !entry.dir) {
          const buffer = (await entry.async('arraybuffer')) as ArrayBuffer;
          const ext = resolvedPath.split('.').pop()?.toLowerCase() ?? '';
          const mimeType = MdzArchiveCore.IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream';
          img.setAttribute('src', `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`);
        }
      } catch {
        // Skip un-resolvable image references silently
      }
    }
  }

  // ---- Public accessors ----

  /**
   * Returns the current Markdown text held by the view.
   *
   * If the view is in source mode, flushes the textarea first so the value
   * is always up-to-date.
   */
  getMarkdownContent(): string {
    if (this.mode === 'source') {
      this.syncFromEditor();
    }
    return this.markdownContent;
  }

  // ---- Saving ----

  /**
   * Persist the current markdown content back into the .mdz archive.
   *
   * Uses `MdzArchiveCore.addFile` to update the entry-point file while
   * preserving the rest of the archive (other files, assets, existing
   * manifest timestamps, etc.).
   */
  async saveCurrentContent(): Promise<void> {
    if (this.isSaving) return;
    if (!this.file || !this.archiveBytes) {
      new Notice('No file loaded.');
      return;
    }

    // Capture latest edits if in source mode
    if (this.mode === 'source') {
      this.syncFromEditor();
    }

    this.isSaving = true;
    this.saveBtn.disabled = true;
    this.saveBtn.setText('Saving…');

    try {
      const result = await MdzArchiveCore.addFile(
        new Uint8Array(this.archiveBytes),
        this.entryPointPath,
        this.markdownContent
      );

      this.archiveBytes = await result.blob.arrayBuffer();

      // Re-open the updated archive so image resolution stays in sync
      this.archive = await MdzArchiveCore.open(new Uint8Array(this.archiveBytes));

      await this.app.vault.modifyBinary(this.file, this.archiveBytes);

      this.isDirty = false;
      this.updateSaveButton();
      new Notice('Saved.');
    } catch (err) {
      new Notice(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSaving = false;
      this.saveBtn.setText('Save');
      this.updateSaveButton();
    }
  }

  // ---- Helpers ----

  private updateTitle(): void {
    const title = this.archiveManifest?.title ?? this.file?.basename ?? '';
    const suffix = this.entryPointPath !== 'index.md' ? ` (${this.entryPointPath})` : '';
    this.titleEl.setText(title + suffix);
  }

  private updateSaveButton(): void {
    this.saveBtn.disabled = !this.isDirty;
  }

  private clearContent(): void {
    this.previewEl?.empty();
    if (this.editorEl) this.editorEl.value = '';
    this.statusEl?.hide();
    this.titleEl?.setText('');
  }

  private showStatus(message: string): void {
    this.previewEl.hide();
    this.editorEl.hide();
    this.statusEl.setText(message);
    this.statusEl.show();
  }

  private showError(message: string): void {
    this.previewEl.hide();
    this.editorEl.hide();
    this.statusEl.empty();
    this.statusEl.addClass('mdz-error');
    this.statusEl.createEl('p', { text: message });
    this.statusEl.show();
  }
}

// ---- Utility ----

/**
 * Encode an ArrayBuffer as a base64 string without exceeding the call-stack
 * limit by processing the bytes in chunks.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
