import type { App, View, WorkspaceLeaf } from 'obsidian';
import type { ArchiveCatalog, ArchiveSummary, NoteToArchiveLink } from './archive-catalog';

/** The data Obsidian's graph view hands to its renderer. */
export interface GraphNode {
  type: string;
  links: Record<string, boolean>;
  color?: unknown;
}
export interface GraphData {
  nodes: Record<string, GraphNode>;
  numLinks?: number;
}

/** The graph view options that matter here (from the view's data engine). */
export interface GraphOptions {
  showOrphans: boolean;
  hideUnresolved: boolean;
  localFile: string | null;
  localJumps: number;
  localForelinks: boolean;
  localBacklinks: boolean;
}

/** Inputs for adding archive documents to graph data. */
export interface ArchiveGraphInput {
  summaries: ArchiveSummary[];
  noteLinks: ReadonlyMap<string, NoteToArchiveLink[]>;
  /** Vault note → vault targets (Obsidian's resolvedLinks), for local-graph neighbourhoods. */
  resolvedLinks: Record<string, Record<string, number>>;
  /** Node to show as focused (the open archive document), if any. */
  focus: string | null;
  /** True when the graph view has a search filter; archive nodes are then left out. */
  filtered: boolean;
}

/**
 * Add archive documents to graph data computed by Obsidian.
 *
 * - Every Markdown document of every archive becomes a node; an archive's
 *   entry point is the archive's own node (see nodeId).
 * - Links between archive documents, out of archives to vault notes, and
 *   from vault notes into archives become edges. Obsidian shows links into
 *   archives as unresolved nodes; those are replaced by the real documents.
 * - In a local graph, only archive nodes within `localJumps` of the local
 *   file (or, for an archive, of its focused document) are added.
 *
 * Pure: returns new data, leaving `data` untouched.
 */
export function addArchivesToGraph(data: GraphData, options: GraphOptions, input: ArchiveGraphInput): GraphData {
  const nodes: Record<string, GraphNode> = {};
  for (const [id, node] of Object.entries(data.nodes ?? {})) nodes[id] = { ...node, links: { ...node.links } };

  // All edges contributed by archives: archive docs → targets, notes → archive docs.
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  const archiveNodes = new Set<string>();
  for (const summary of input.summaries) {
    for (const doc of summary.docs) {
      const id = doc === summary.entryPoint ? summary.path : `${summary.path}/${doc}`;
      archiveNodes.add(id);
      for (const target of summary.links.get(doc) ?? []) addEdge(id, target);
    }
  }
  const remapped = new Map<string, Set<string>>(); // note → unresolved ids that now resolve
  for (const [note, links] of input.noteLinks) {
    for (const l of links) {
      addEdge(note, l.target);
      if (!remapped.has(note)) remapped.set(note, new Set());
      remapped.get(note)!.add(l.unresolvedId);
    }
  }

  // Drop Obsidian's unresolved stand-ins for links that now resolve.
  for (const [note, ids] of remapped) {
    const node = nodes[note];
    if (!node) continue;
    for (const id of ids) delete node.links[id];
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== 'unresolved') continue;
    const stillUsed = Object.values(nodes).some((n) => n.links[id]);
    if (!stillUsed) delete nodes[id];
  }

  if (input.filtered) return { ...data, nodes };

  // Which archive nodes to include.
  let include: Set<string>;
  if (options.localFile) {
    const center = input.focus ?? options.localFile;
    include = neighbourhood(center, options, edges, input.resolvedLinks);
    include.add(center);
  } else {
    include = new Set(archiveNodes);
    for (const [from, tos] of edges) {
      if (nodes[from]) tos.forEach((t) => include.add(t));
    }
  }

  const ensure = (id: string) => {
    if (!nodes[id]) nodes[id] = { type: '', links: {} };
    else if (archiveNodes.has(id) && nodes[id].type === 'attachment') nodes[id].type = '';
  };
  for (const id of include) {
    if (archiveNodes.has(id) || nodes[id] || options.localFile) ensure(id);
  }
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if ((nodes[from] || include.has(from)) && (nodes[to] || include.has(to))) {
        if (!nodes[from]) ensure(from);
        if (!nodes[to]) ensure(to);
        nodes[from].links[to] = true;
      }
    }
  }

  if (!options.showOrphans) {
    const linked = new Set<string>();
    for (const [id, node] of Object.entries(nodes)) {
      for (const to of Object.keys(node.links)) {
        if (nodes[to] && to !== id) {
          linked.add(id);
          linked.add(to);
        }
      }
    }
    for (const id of archiveNodes) if (nodes[id] && !linked.has(id)) delete nodes[id];
  }

  if (input.focus && nodes[input.focus]) {
    for (const node of Object.values(nodes)) if (node.type === 'focused') node.type = '';
    nodes[input.focus].type = 'focused';
  }
  return { ...data, nodes };
}

/** Nodes within `localJumps` of `center`, following forelinks and/or backlinks across vault and archive edges. */
function neighbourhood(
  center: string,
  options: GraphOptions,
  edges: Map<string, Set<string>>,
  resolvedLinks: Record<string, Record<string, number>>
): Set<string> {
  const out = new Map<string, Set<string>>();
  const back = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a)!.add(b);
    if (!back.has(b)) back.set(b, new Set());
    back.get(b)!.add(a);
  };
  for (const [from, tos] of edges) tos.forEach((t) => link(from, t));
  for (const [from, tos] of Object.entries(resolvedLinks)) Object.keys(tos).forEach((t) => link(from, t));

  const seen = new Set([center]);
  let frontier = [center];
  for (let depth = 0; depth < Math.max(1, options.localJumps); depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbours = [
        ...(options.localForelinks ? out.get(id) ?? [] : []),
        ...(options.localBacklinks ? back.get(id) ?? [] : []),
      ];
      for (const n of neighbours) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

interface GraphEngine {
  options: GraphOptions;
  searchQueries: unknown[] | null;
  render(): unknown;
}
interface GraphLikeView extends View {
  renderer?: { setData(data: GraphData): void };
  dataEngine?: GraphEngine;
  engine?: GraphEngine;
}

/**
 * Hooks Obsidian's graph and local graph views so they include archive
 * documents. Wraps each view's `renderer.setData`, so nothing outside the
 * graph view sees the added nodes (the metadata cache is untouched).
 */
export class GraphIntegration {
  private input: Omit<ArchiveGraphInput, 'focus' | 'filtered' | 'resolvedLinks'> = {
    summaries: [],
    noteLinks: new Map(),
  };
  /** Wrapped renderers and their original setData, to restore on unload. */
  private wrapped = new Map<{ setData(data: GraphData): void }, { original: (data: GraphData) => void; engine: GraphEngine }>();

  private app: App;
  private catalog: ArchiveCatalog;
  private focusFor: (localFile: string | null) => string | null;

  constructor(app: App, catalog: ArchiveCatalog, focusFor: (localFile: string | null) => string | null) {
    this.app = app;
    this.catalog = catalog;
    this.focusFor = focusFor;
  }

  /** Refresh archive data from the catalog and redraw open graphs. */
  async refresh(): Promise<void> {
    this.input = { summaries: await this.catalog.summaries(), noteLinks: this.catalog.noteToArchiveLinks() };
    this.hookAll(true);
  }

  /** Wrap any graph views not yet wrapped; optionally redraw all of them. */
  hookAll(redraw = false): void {
    for (const type of ['graph', 'localgraph']) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) this.hook(leaf, redraw);
    }
  }

  private hook(leaf: WorkspaceLeaf, redraw: boolean): void {
    const view = leaf.view as GraphLikeView;
    const renderer = view.renderer;
    const engine = view.dataEngine ?? view.engine;
    if (!renderer || !engine || typeof renderer.setData !== 'function') return;
    if (!this.wrapped.has(renderer)) {
      const original = renderer.setData;
      const bound = original.bind(renderer);
      this.wrapped.set(renderer, { original, engine });
      renderer.setData = (data: GraphData) => {
        try {
          const options = engine.options;
          data = addArchivesToGraph(data, options, {
            ...this.input,
            resolvedLinks: this.app.metadataCache.resolvedLinks,
            focus: this.focusFor(options.localFile),
            filtered: !!engine.searchQueries?.length,
          });
        } catch (err) {
          console.error('MDZip: could not add archives to the graph', err);
        }
        bound(data);
      };
      redraw = true;
    }
    if (redraw) engine.render();
  }

  /** Restore every wrapped graph view and redraw it without archive nodes. */
  unhookAll(): void {
    for (const [renderer, { original, engine }] of this.wrapped) {
      renderer.setData = original;
      try {
        engine.render();
      } catch {
        // The view may already be closed.
      }
    }
    this.wrapped.clear();
  }
}
