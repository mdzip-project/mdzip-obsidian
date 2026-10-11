import type { ArchiveSummary, NoteToArchiveLink } from './archive-catalog';

/** Where an archive document node lives. */
export interface ArchiveNodeLocation {
  archive: string;
  doc: string;
}

/**
 * Incoming and outgoing links between archive documents and vault notes, as
 * graph node ids (see nodeId in archive-catalog.ts).
 */
export interface LinkIndex {
  outgoing(id: string): string[];
  incoming(id: string): string[];
  /** Links written in an archive document that don't resolve. */
  unresolved(id: string): string[];
  /** The archive and document behind an archive node id, or null for a vault note. */
  locate(id: string): ArchiveNodeLocation | null;
}

/**
 * Build a LinkIndex from the catalog's archive summaries, regular notes'
 * links into archives, and Obsidian's resolvedLinks (for notes that link to a
 * `.mdz` file itself, which means its entry point).
 */
export function buildLinkIndex(
  summaries: ArchiveSummary[],
  noteLinks: ReadonlyMap<string, NoteToArchiveLink[]>,
  resolvedLinks: Record<string, Record<string, number>>
): LinkIndex {
  const out = new Map<string, Set<string>>();
  const back = new Map<string, Set<string>>();
  const missing = new Map<string, string[]>();
  const located = new Map<string, ArchiveNodeLocation>();
  const archives = new Set<string>();
  const link = (from: string, to: string) => {
    if (from === to) return;
    if (!out.has(from)) out.set(from, new Set());
    out.get(from)!.add(to);
    if (!back.has(to)) back.set(to, new Set());
    back.get(to)!.add(from);
  };

  for (const s of summaries) {
    archives.add(s.path);
    for (const doc of s.docs) {
      const id = doc === s.entryPoint ? s.path : `${s.path}/${doc}`;
      located.set(id, { archive: s.path, doc });
      for (const to of s.links.get(doc) ?? []) link(id, to);
      const notFound = s.unresolved?.get(doc);
      if (notFound?.length) missing.set(id, notFound);
    }
  }
  for (const [note, links] of noteLinks) for (const l of links) link(note, l.target);
  for (const [from, targets] of Object.entries(resolvedLinks)) {
    for (const to of Object.keys(targets)) if (archives.has(to)) link(from, to);
  }

  const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort((a, b) => a.localeCompare(b));
  return {
    outgoing: (id) => sorted(out.get(id)),
    incoming: (id) => sorted(back.get(id)),
    unresolved: (id) => missing.get(id) ?? [],
    locate: (id) => located.get(id) ?? null,
  };
}
