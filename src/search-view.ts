import { debounce, ItemView, setIcon, WorkspaceLeaf } from 'obsidian';
import { ArchiveCatalog, SearchMatch } from './archive-catalog';
import { VIEW_TYPE_MDZ } from './mdz-view';

export const VIEW_TYPE_MDZ_SEARCH = 'mdz-search';

const MAX_MATCHES = 1000;

/**
 * Sidebar search across the text of every document inside every .mdz in the
 * vault. Obsidian's own search only reads .md and .canvas files, so archive
 * contents need their own search. Searches on demand (no stored index),
 * case-insensitively, and streams results as each archive is read.
 */
export class MdzSearchView extends ItemView {
  private inputEl!: HTMLInputElement;
  private summaryEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private runId = 0;
  private pendingQuery: string | null = null;
  private runLater = debounce(() => void this.run(), 300, true);

  constructor(
    leaf: WorkspaceLeaf,
    private catalog: ArchiveCatalog
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MDZ_SEARCH;
  }

  getDisplayText(): string {
    return 'Search MDZip archives';
  }

  getIcon(): string {
    return 'package-search';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('mdz-search');
    this.inputEl = root.createEl('input', {
      cls: 'mdz-search-input',
      attr: { type: 'search', placeholder: 'Search inside .mdz files…', spellcheck: 'false' },
    });
    this.inputEl.addEventListener('input', () => this.runLater());
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') void this.run();
    });
    this.summaryEl = root.createDiv({ cls: 'mdz-search-summary' });
    this.resultsEl = root.createDiv({ cls: 'mdz-search-results' });
    if (this.pendingQuery !== null) {
      const query = this.pendingQuery;
      this.pendingQuery = null;
      this.focusQuery(query || undefined);
    }
  }

  async onClose(): Promise<void> {
    this.runId++; // cancel any search in progress
  }

  /** Focus the query box, optionally with a starting query. */
  focusQuery(query?: string): void {
    if (!this.inputEl) {
      // Not opened yet (sidebar views open lazily); apply once it is.
      this.pendingQuery = query ?? '';
      return;
    }
    if (query !== undefined) {
      this.inputEl.value = query;
      void this.run();
    }
    this.inputEl.focus();
    this.inputEl.select();
  }

  private async run(): Promise<void> {
    const id = ++this.runId;
    const query = this.inputEl.value.trim();
    this.resultsEl.empty();
    if (!query) {
      this.summaryEl.setText('');
      return;
    }
    this.summaryEl.setText('Searching…');
    const groups = new Map<string, HTMLElement>(); // archive/doc → match list
    const archives = new Map<string, HTMLElement>();
    const docsSeen = new Set<string>();

    const count = await this.catalog.search(
      query,
      (match) => {
        if (id !== this.runId) return;
        let archiveEl = archives.get(match.archive);
        if (!archiveEl) {
          archiveEl = this.resultsEl.createDiv({ cls: 'mdz-search-archive' });
          const title = archiveEl.createDiv({ cls: 'mdz-search-archive-title' });
          setIcon(title.createSpan({ cls: 'mdz-search-icon' }), 'package');
          title.createSpan({ text: match.archive });
          archives.set(match.archive, archiveEl);
        }
        const key = `${match.archive}\u0000${match.doc}`;
        let list = groups.get(key);
        if (!list) {
          docsSeen.add(key);
          const docEl = archiveEl.createDiv({ cls: 'mdz-search-doc' });
          docEl.createDiv({ cls: 'mdz-search-doc-title', text: match.doc });
          list = docEl.createDiv({ cls: 'mdz-search-matches' });
          groups.set(key, list);
        }
        this.renderMatch(list, match);
      },
      () => id !== this.runId,
      MAX_MATCHES
    );
    if (id !== this.runId) return;
    const docs = docsSeen.size;
    this.summaryEl.setText(
      count === 0
        ? 'No matches in .mdz files.'
        : `${count}${count >= MAX_MATCHES ? '+' : ''} match${count === 1 ? '' : 'es'} in ${docs} document${docs === 1 ? '' : 's'}` +
            (count >= MAX_MATCHES ? ' (showing the first 1000)' : '')
    );
  }

  private renderMatch(list: HTMLElement, match: SearchMatch): void {
    const el = list.createDiv({ cls: 'mdz-search-match' });
    // Trim long lines around the match.
    const from = Math.max(0, match.start - 60);
    const to = Math.min(match.text.length, match.end + 120);
    el.createSpan({ text: (from > 0 ? '…' : '') + match.text.slice(from, match.start) });
    el.createEl('mark', { text: match.text.slice(match.start, match.end) });
    el.createSpan({ text: match.text.slice(match.end, to) + (to < match.text.length ? '…' : '') });
    el.addEventListener('click', (evt) => void this.openMatch(match, evt.ctrlKey || evt.metaKey));
  }

  private async openMatch(match: SearchMatch, newTab: boolean): Promise<void> {
    const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
    await leaf.setViewState(
      { type: VIEW_TYPE_MDZ, state: { file: match.archive, mdzDoc: match.doc }, active: true },
      { line: match.line, cursor: { from: { line: match.line, ch: match.start }, to: { line: match.line, ch: match.end } } }
    );
  }
}
