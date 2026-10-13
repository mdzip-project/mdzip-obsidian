import { EventRef, ItemView, MarkdownView, setIcon, WorkspaceLeaf } from 'obsidian';
import type { LinkIndex } from './link-index';
import { MdzView } from './mdz-view';

export const VIEW_TYPE_MDZ_LINKS = 'mdz-links';

/** What the panel is showing links for. */
interface Subject {
  /** Graph node id: an archive document or a vault note path. */
  id: string;
  label: string;
  isArchiveDoc: boolean;
}

/**
 * Incoming and outgoing links for the open document, including archive
 * documents, which Obsidian's own backlinks and outgoing-links panes can't
 * see. For an archive document it lists everything; for a regular note it
 * lists the archive documents that link to it and its links into archives
 * (Obsidian's panes already cover note-to-note links).
 */
export class MdzLinksView extends ItemView {
  private subject: Subject | null = null;
  private renderId = 0;
  private getIndex: () => Promise<LinkIndex>;

  constructor(leaf: WorkspaceLeaf, getIndex: () => Promise<LinkIndex>) {
    super(leaf);
    this.getIndex = getIndex;
  }

  getViewType(): string {
    return VIEW_TYPE_MDZ_LINKS;
  }

  getDisplayText(): string {
    return 'Archive links';
  }

  getIcon(): string {
    return 'package-open';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('mdz-links');
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.follow(leaf)));
    this.registerEvent(
      (this.app.workspace as unknown as { on(name: string, cb: () => void): EventRef }).on(
        'mdzip:document-open',
        () => this.follow(this.app.workspace.getMostRecentLeaf())
      )
    );
    this.follow(this.app.workspace.getMostRecentLeaf());
  }

  /** Redraw with fresh link data (called when the archive catalog changes). */
  refresh(): void {
    void this.render();
  }

  /** Track the last document tab used; ignore sidebars and other views. */
  private follow(leaf: WorkspaceLeaf | null): void {
    const view = leaf?.view;
    let next: Subject | null = this.subject;
    if (view instanceof MdzView && view.file) {
      const archive = view.file.path;
      const doc = view.getCurrentDocument();
      const id = doc === view.getEntryPoint() ? archive : `${archive}/${doc}`;
      next = { id, label: `${view.file.name} › ${doc}`, isArchiveDoc: true };
    } else if (view instanceof MarkdownView && view.file) {
      next = { id: view.file.path, label: view.file.basename, isArchiveDoc: false };
    }
    if (next?.id !== this.subject?.id || next?.label !== this.subject?.label) {
      this.subject = next;
      void this.render();
    }
  }

  private async render(): Promise<void> {
    const id = ++this.renderId;
    const subject = this.subject;
    const index = await this.getIndex();
    if (id !== this.renderId) return;

    const root = this.contentEl;
    root.empty();
    if (!subject) {
      root.createDiv({ cls: 'mdz-links-empty', text: 'Open a document to see its links.' });
      return;
    }
    root.createDiv({ cls: 'mdz-links-subject', text: subject.label });

    const isArchive = (n: string) => index.locate(n) !== null;
    const incoming = index.incoming(subject.id).filter((n) => subject.isArchiveDoc || isArchive(n));
    const outgoing = index.outgoing(subject.id).filter((n) => subject.isArchiveDoc || isArchive(n));

    if (!subject.isArchiveDoc) {
      // A regular note: only the links Obsidian's own panes can't see.
      root.createDiv({
        cls: 'mdz-links-hint',
        text: "Links between this note and documents inside .mdz files. Links to other notes are in Obsidian's Backlinks and Outgoing links panes.",
      });
      if (!incoming.length && !outgoing.length) {
        root.createDiv({ cls: 'mdz-links-none', text: 'No links to or from archives.' });
        return;
      }
      if (incoming.length) this.section(root, 'Linked from archives', incoming, index);
      if (outgoing.length) this.section(root, 'Links into archives', outgoing, index);
      return;
    }

    this.section(root, 'Linked from', incoming, index);
    this.section(root, 'Links to', outgoing, index);
    const missing = index.unresolved(subject.id);
    if (missing.length) {
      const sec = this.header(root, 'Not found', missing.length);
      for (const link of missing) sec.createDiv({ cls: 'mdz-links-item mdz-links-missing', text: link });
    }
  }

  private header(root: HTMLElement, title: string, count: number): HTMLElement {
    const sec = root.createDiv({ cls: 'mdz-links-section' });
    const head = sec.createDiv({ cls: 'mdz-links-section-title' });
    head.createSpan({ text: title });
    head.createSpan({ cls: 'mdz-links-count', text: String(count) });
    return sec;
  }

  private section(root: HTMLElement, title: string, ids: string[], index: LinkIndex): void {
    const sec = this.header(root, title, ids.length);
    if (!ids.length) {
      sec.createDiv({ cls: 'mdz-links-none', text: 'None' });
      return;
    }
    for (const nodeId of ids) {
      const where = index.locate(nodeId);
      const item = sec.createDiv({ cls: 'mdz-links-item', attr: { title: nodeId } });
      setIcon(item.createSpan({ cls: 'mdz-links-icon' }), where ? 'package' : 'file-text');
      if (where) {
        item.createSpan({ cls: 'mdz-links-archive', text: `${where.archive.split('/').pop()} › ` });
        item.createSpan({ text: where.doc });
      } else {
        item.createSpan({ text: (nodeId.split('/').pop() ?? nodeId).replace(/\.md$/i, '') });
      }
      item.addEventListener('click', (evt) => {
        void this.app.workspace.openLinkText(nodeId, '', evt.ctrlKey || evt.metaKey ? 'tab' : false);
      });
    }
  }
}
