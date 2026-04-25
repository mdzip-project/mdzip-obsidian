import { Notice, Plugin, TFile } from 'obsidian';
import { MdzPackagerCore } from 'mdzip-core-js';
import { MdzView, VIEW_TYPE_MDZ } from './mdz-view';

/**
 * MDZip Obsidian Plugin
 *
 * Registers `.mdz` as a first-class file type in Obsidian and provides:
 *
 *  - A custom view ({@link MdzView}) that reads and writes single-document
 *    .mdz archives in both preview and editable source modes.
 *
 *  - "Export note as .mdz" command – packages the active Markdown note into
 *    a new .mdz file placed alongside it in the vault.
 *
 *  - "Extract Markdown from .mdz" command – reads the entry-point Markdown
 *    out of the active .mdz view and creates a new .md file in the vault.
 */
export default class MdzPlugin extends Plugin {
  async onload(): Promise<void> {
    // Register the custom view for .mdz files
    this.registerView(VIEW_TYPE_MDZ, (leaf) => new MdzView(leaf));

    // Tell Obsidian to open .mdz files with this plugin's view
    this.registerExtensions(['mdz'], VIEW_TYPE_MDZ);

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
      const mdPath = file.path.replace(/\.mdz$/i, '.extracted.md');

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
