/** A match of a search query within one line of a document. */
export interface LineMatch {
  /** 0-based line number. */
  line: number;
  text: string;
  /** Match position within `text`. */
  start: number;
  end: number;
}

/**
 * Lines of `text` containing `query` (case-insensitive), one match per line
 * (its first occurrence), at most `limit`. Pure.
 */
export function matchLines(text: string, query: string, limit = Infinity): LineMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle || limit <= 0 || !text.toLocaleLowerCase().includes(needle)) return [];
  const out: LineMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const at = lines[i].toLocaleLowerCase().indexOf(needle);
    if (at >= 0) out.push({ line: i, text: lines[i], start: at, end: at + needle.length });
  }
  return out;
}
