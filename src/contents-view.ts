import { EventRef, ItemView, Keymap, Menu, Modal, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { buildContentsTree, findUnreferencedImages, type ContentsNode } from './contents-tree';
import { MdzView } from './mdz-view';
import { isSupportFile } from './contents-tree';
import type { SupportFileKind } from './support-files';
import type { ArchiveActions } from './archive-actions';

export const VIEW_TYPE_MDZ_CONTENTS = 'mdz-contents';

/**
 * The open archive's files as a tree, in the left sidebar next to the file
 * explorer and styled like it. Documents open in the archive's tab; images
 * and manifest.json open in a preview. The entry point is pinned first and
 * marked; support files (README, AGENTS, ...) and images no document refers
 * to are dimmed. Right-click menus add, rename, move and delete entries;
 * dragging a file or folder onto a folder (or the empty space below the
 * tree, for the root) moves it.
 */
export class MdzContentsView extends ItemView {
  private view: MdzView | null = null;
  /** Collapsed folders, per archive path. */
  private collapsed = new Map<string, Set<string>>();
  private rows = new Map<string, HTMLElement>();
  private unreferenced: { key: string; paths: Set<string> } | null = null;
  private renderId = 0;
  /** Drop targets while dragging: folder path → its tree item; `''` (the root) → the tree. */
  private folderRows = new Map<string, HTMLElement>();
  private dragging: { path: string; isFolder: boolean } | null = null;
  private dropTarget: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private actions: ArchiveActions
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MDZ_CONTENTS;
  }

  getDisplayText(): string {
    return 'Archive contents';
  }

  getIcon(): string {
    return 'folder-tree';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('mdz-contents');
    const on = (name: string, cb: () => void) =>
      (this.app.workspace as unknown as { on(name: string, cb: () => void): EventRef }).on(name, cb);
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.follow(leaf)));
    this.registerEvent(on('mdzip:document-open', () => this.follow(this.app.workspace.getMostRecentLeaf(), true)));
    this.registerEvent(on('mdzip:archive-changed', () => this.follow(this.app.workspace.getMostRecentLeaf(), true)));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    // Clear the pane when the archive's tab is closed.
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (this.view && this.view.leaf.view !== this.view) this.render();
      })
    );
    // Once the sidebar has finished revealing this pane, so the document tab is the most recent leaf again.
    this.app.workspace.onLayoutReady(() => window.setTimeout(() => this.follow(null, true), 0));
  }

  /**
   * Track the archive in the last document tab used. Sidebar leaves are
   * ignored; another kind of document in the main area clears the pane.
   */
  private follow(leaf: WorkspaceLeaf | null, force = false): void {
    const { workspace } = this.app;
    if (!leaf || leaf.getRoot() !== workspace.rootSplit) {
      // A sidebar leaf (this pane, the file explorer, ...): use the last document tab instead.
      if (!force) return;
      leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
      if (!leaf || leaf.getRoot() !== workspace.rootSplit) {
        this.render();
        return;
      }
    }
    const next = leaf.view instanceof MdzView ? leaf.view : null;
    if (next !== this.view || force) {
      this.view = next;
      this.render();
    }
  }

  private render(): void {
    const id = ++this.renderId;
    const { contentEl } = this;
    // Rebuilding resets the scroll position; keep it, then bring the current document into view.
    const scrollTop = contentEl.scrollTop;
    contentEl.empty();
    this.rows.clear();
    this.folderRows.clear();
    this.dropTarget = null;

    const view = this.view;
    const file = view?.file;
    if (!view || !file || view.leaf.view !== view) {
      this.view = null;
      contentEl.createDiv({ cls: 'pane-empty', text: 'Open an .mdz file to see its contents.' });
      return;
    }

    const entries = view.listArchiveEntries();
    const tree = buildContentsTree(entries, view.getEntryPoint());
    const archiveKey = file.path;
    const collapsed = this.collapsed.get(archiveKey) ?? new Set<string>();
    this.collapsed.set(archiveKey, collapsed);

    // Header: buttons, then the archive's name and mode.
    const header = contentEl.createDiv({ cls: 'nav-header' });
    const buttons = header.createDiv({ cls: 'nav-buttons-container' });
    const button = (icon: string, label: string, onClick: () => void) => {
      const el = buttons.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', onClick);
      return el;
    };
    button('house', 'Open the entry point', () => void view.openDocument(view.getEntryPoint()));
    const add = button('file-plus', 'Add to archive', () => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('New document').setIcon('file-plus').onClick(() => void this.actions.newDocument(file)));
      menu.addItem((i) => i.setTitle('New folder').setIcon('folder-plus').onClick(() => void this.actions.newFolder(file)));
      menu.addSeparator();
      for (const kind of ['README', 'AGENTS'] as SupportFileKind[]) {
        const present = entries.find((e) => isSupportFile(e.path) && e.path.toUpperCase().startsWith(`${kind}.`));
        menu.addItem((i) =>
          i
            .setTitle(present ? `Open ${present.path}` : `Add ${kind}.md`)
            .setIcon(kind === 'README' ? 'book-open' : 'bot')
            .onClick(() => void this.actions.addSupportFile(file, kind))
        );
      }
      const rect = add.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
    const folders = tree.length ? walkFolders(tree) : [];
    const allCollapsed = folders.length > 0 && folders.every((f) => collapsed.has(f));
    button(allCollapsed ? 'chevrons-up-down' : 'chevrons-down-up', allCollapsed ? 'Expand all' : 'Collapse all', () => {
      if (allCollapsed) collapsed.clear();
      else folders.forEach((f) => collapsed.add(f));
      this.render();
    });

    const title = contentEl.createDiv({ cls: 'mdz-contents-title' });
    setIcon(title.createSpan({ cls: 'mdz-contents-title-icon' }), 'package');
    title.createSpan({ cls: 'mdz-contents-title-name', text: file.basename });
    title.createSpan({ cls: 'nav-file-tag mdz-contents-mode', text: view.getArchiveMode() });
    setTooltip(title, `${file.path}\n${entries.filter((e) => !e.isDirectory).length} files`, { placement: 'bottom' });

    const container = contentEl.createDiv({ cls: 'nav-files-container mdz-contents-tree' });
    // Dropping below the tree moves to the archive's root.
    this.folderRows.set('', container);
    container.addEventListener('dragover', (evt) => this.dragOver(evt, ''));
    container.addEventListener('drop', (evt) => this.drop(evt, file, ''));
    container.addEventListener('dragleave', (evt) => {
      if (!(evt.relatedTarget instanceof Node && container.contains(evt.relatedTarget))) this.highlight(null);
    });
    const current = view.getCurrentDocument();
    for (const node of tree) this.renderNode(container, node, view, collapsed, current);
    contentEl.scrollTop = scrollTop;
    this.rows.get(current)?.scrollIntoView({ block: 'nearest' });

    void this.markUnreferenced(id, view);
  }

  private renderNode(parent: HTMLElement, node: ContentsNode, view: MdzView, collapsed: Set<string>, current: string): void {
    if (node.kind === 'folder') {
      const isCollapsed = collapsed.has(node.path);
      const item = parent.createDiv({ cls: ['tree-item', 'nav-folder'] });
      if (isCollapsed) item.addClass('is-collapsed');
      const self = item.createDiv({
        cls: ['tree-item-self', 'nav-folder-title', 'is-clickable', 'mod-collapsible'],
        attr: { 'data-path': node.path },
      });
      const icon = self.createDiv({ cls: ['tree-item-icon', 'collapse-icon'] });
      if (isCollapsed) icon.addClass('is-collapsed');
      setIcon(icon, 'right-triangle');
      self.createDiv({ cls: ['tree-item-inner', 'nav-folder-title-content'], text: node.name });
      self.addEventListener('click', () => {
        if (collapsed.has(node.path)) collapsed.delete(node.path);
        else collapsed.add(node.path);
        this.render();
      });
      self.addEventListener('contextmenu', (evt) => this.menu(evt, node, view));
      this.folderRows.set(node.path, item);
      this.draggable(self, node, false);
      item.addEventListener('dragover', (evt) => this.dragOver(evt, node.path));
      item.addEventListener('drop', (evt) => view.file && this.drop(evt, view.file, node.path));
      if (!isCollapsed) {
        const children = item.createDiv({ cls: ['tree-item-children', 'nav-folder-children'] });
        for (const child of node.children) this.renderNode(children, child, view, collapsed, current);
      }
      return;
    }

    const item = parent.createDiv({ cls: ['tree-item', 'nav-file'] });
    const self = item.createDiv({
      cls: ['tree-item-self', 'nav-file-title', 'is-clickable'],
      attr: { 'data-path': node.path },
    });
    this.draggable(self, node, node.kind === 'manifest');
    if (node.kind === 'document' && node.path === current) self.addClass('is-active');
    if (node.support || node.kind === 'manifest') self.addClass('mdz-contents-muted');

    const extension = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.') + 1) : '';
    // Like Obsidian's file explorer: Markdown names without the extension, other files with a tag.
    const label = node.kind === 'document' ? node.name.replace(/\.(md|markdown)$/i, '') : node.name.replace(/\.[^.]+$/, '');
    self.createDiv({ cls: ['tree-item-inner', 'nav-file-title-content'], text: label || node.name });
    if (node.entryPoint) {
      const flag = self.createDiv({ cls: 'mdz-contents-flag' });
      setIcon(flag, 'house');
      setTooltip(flag, 'Entry point');
    }
    if (node.kind !== 'document' && extension) self.createDiv({ cls: 'nav-file-tag', text: extension });

    const hint = [node.path];
    if (node.entryPoint) hint.push('Entry point');
    if (node.support) hint.push('Support file: describes the archive, not part of the document');
    if (node.size !== undefined) hint.push(formatSize(node.size));
    setTooltip(self, hint.join('\n'), { placement: 'right' });

    if (node.kind === 'file') self.addClass('mdz-contents-static');
    self.addEventListener('click', (evt) => this.openNode(node, view, Keymap.isModEvent(evt)));
    self.addEventListener('contextmenu', (evt) => this.menu(evt, node, view));
    this.rows.set(node.path, self);
  }

  private openNode(node: ContentsNode, view: MdzView, newTab: boolean | string): void {
    if (node.kind === 'document') void view.openDocument(node.path, newTab ? 'tab' : undefined);
    else if (node.kind === 'image') new ImagePreview(this.app, view, node.path).open();
    else if (node.kind === 'manifest') new TextPreview(this.app, view, node.path).open();
  }

  private menu(evt: MouseEvent, node: ContentsNode, view: MdzView): void {
    const file = view.file;
    if (!file) return;
    const isFolder = node.kind === 'folder';
    const menu = new Menu();
    if (isFolder) {
      menu.addItem((i) =>
        i.setTitle('New document here').setIcon('file-plus').onClick(() => void this.actions.newDocument(file, node.path))
      );
      menu.addItem((i) =>
        i.setTitle('New folder here').setIcon('folder-plus').onClick(() => void this.actions.newFolder(file, node.path))
      );
    } else if (node.kind === 'document') {
      menu.addItem((i) => i.setTitle('Open').setIcon('file-text').onClick(() => void view.openDocument(node.path)));
      menu.addItem((i) =>
        i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => void view.openDocument(node.path, 'tab'))
      );
    } else if (node.kind === 'image' || node.kind === 'manifest') {
      menu.addItem((i) => i.setTitle('Preview').setIcon('eye').onClick(() => this.openNode(node, view, false)));
    }

    if (node.kind !== 'manifest') {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle('Rename...').setIcon('pencil').onClick(() => void this.actions.rename(file, node.path, isFolder))
      );
      menu.addItem((i) =>
        i.setTitle('Move to...').setIcon('folder-input').onClick(() => void this.actions.moveTo(file, node.path, isFolder))
      );
      if (node.kind === 'document' && !node.entryPoint) {
        menu.addItem((i) =>
          i.setTitle('Make entry point').setIcon('house').onClick(() => void this.actions.setEntryPoint(file, node.path))
        );
      }
    }

    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('Copy path').setIcon('copy').onClick(() => void navigator.clipboard.writeText(node.path))
    );
    if (!isFolder) {
      // A link a note next to the archive can use to reach this entry (spec Section 9.5).
      const link = `${encodeURI(file.name)}/${node.path.split('/').map(encodeURIComponent).join('/')}`;
      menu.addItem((i) =>
        i.setTitle('Copy link for a note next to the archive').setIcon('link').onClick(() => void navigator.clipboard.writeText(link))
      );
    }

    if (node.kind !== 'manifest' && !node.entryPoint) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(isFolder ? 'Delete folder' : 'Delete')
          .setIcon('trash-2')
          .setWarning(true)
          .onClick(() => void this.actions.remove(file, node.path, isFolder))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  // ---- Dragging to move ----

  private draggable(el: HTMLElement, node: ContentsNode, fixed: boolean): void {
    el.setAttribute('draggable', fixed ? 'false' : 'true');
    if (fixed) return;
    el.addEventListener('dragstart', (evt) => {
      this.dragging = { path: node.path, isFolder: node.kind === 'folder' };
      if (evt.dataTransfer) {
        evt.dataTransfer.effectAllowed = 'move';
        evt.dataTransfer.setData('application/x-mdzip-entry', node.path);
      }
    });
    el.addEventListener('dragend', () => {
      this.dragging = null;
      this.highlight(null);
    });
  }

  /** Over `folder` (or a file in it): accept the drop if the dragged entry can move there. */
  private dragOver(evt: DragEvent, folder: string): void {
    if (!this.dragging) return;
    evt.stopPropagation();
    const { path, isFolder } = this.dragging;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent === folder || (isFolder && (folder === path || folder.startsWith(`${path}/`)))) {
      this.highlight(null);
      return;
    }
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
    this.highlight(this.folderRows.get(folder) ?? null);
  }

  private drop(evt: DragEvent, file: TFile, folder: string): void {
    const dragged = this.dragging;
    if (!dragged) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.dragging = null;
    this.highlight(null);
    void this.actions.moveInto(file, dragged.path, dragged.isFolder, folder);
  }

  private highlight(el: HTMLElement | null): void {
    if (this.dropTarget === el) return;
    this.dropTarget?.removeClass('mdz-drop-target');
    this.dropTarget = el;
    el?.addClass('mdz-drop-target');
  }

  /** Dim images no document refers to; computed once per archive version, after the tree is shown. */
  private async markUnreferenced(renderId: number, view: MdzView): Promise<void> {
    const key = `${view.file?.path}\u0000${view.getArchiveGeneration()}`;
    if (this.unreferenced?.key !== key) {
      const entries = view.listArchiveEntries();
      let cover: string | undefined;
      try {
        const manifest = JSON.parse((await view.readArchiveText('manifest.json')) ?? 'null');
        if (manifest && typeof manifest.cover === 'string') cover = manifest.cover;
      } catch {
        // No readable manifest: nothing is referenced through it.
      }
      const paths = await findUnreferencedImages(entries, (p) => view.readArchiveText(p), cover);
      this.unreferenced = { key, paths };
    }
    if (renderId !== this.renderId) return;
    for (const path of this.unreferenced.paths) {
      const row = this.rows.get(path);
      if (!row) continue;
      row.addClass('mdz-contents-unreferenced');
      setTooltip(row, `${path}\nNot used by any document in this archive`, { placement: 'right' });
    }
  }
}

function walkFolders(nodes: ContentsNode[]): string[] {
  return nodes.filter((n) => n.kind === 'folder').flatMap((n) => [n.path, ...walkFolders(n.children)]);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An image from the archive, shown in a modal. */
class ImagePreview extends Modal {
  private url: string | null = null;

  constructor(app: MdzView['app'], private view: MdzView, private path: string) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('mdz-preview-modal');
    this.titleEl.setText(this.path);
    this.url = await this.view.archiveImageUrl(this.path);
    if (this.url) this.contentEl.createEl('img', { cls: 'mdz-preview-image', attr: { src: this.url, alt: this.path } });
    else this.contentEl.createDiv({ cls: 'pane-empty', text: "This image can't be shown." });
  }

  onClose(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.contentEl.empty();
  }
}

/** A text entry (manifest.json) from the archive, read-only. */
class TextPreview extends Modal {
  constructor(app: MdzView['app'], private view: MdzView, private path: string) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('mdz-preview-modal');
    this.titleEl.setText(this.path);
    let text = (await this.view.readArchiveText(this.path)) ?? '';
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: show it as written.
    }
    this.contentEl.createEl('pre', { cls: 'mdz-preview-text' }).createEl('code', { text });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
