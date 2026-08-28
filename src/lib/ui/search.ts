/**
 * Listing search matcher (dashboard v2) powering the ⌘K command palette's
 * ranking: every whitespace-separated query token must appear in the title,
 * case-insensitively, in any order.
 */

function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The one token the /api/search route pushes down into its Postgres ilike
 * filter (PostgREST `.or()` syntax breaks on `,.()"` — `.` delimits
 * column.operator.value — and `%_*\` are pattern metacharacters — stripped
 * rather than escaped; the in-process matcher still applies the FULL query
 * afterwards). Empty result = skip the DB filter and fall back to
 * recency-bounded candidates.
 */
export function firstSearchToken(query: string): string {
  const first = query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
  return first.replace(/[,.()"%_*\\]/g, "");
}

export interface SearchableRow {
  title: string;
  /** ISO timestamp — ties in rank break newest-first. */
  createdAt: string;
}

/**
 * Rank: title-prefix match > word-start match > plain substring, then
 * recency. Empty queries return nothing — the palette renders quick actions
 * for that state instead of dumping the whole inventory.
 */
export function searchRows<T extends SearchableRow>(
  rows: T[],
  query: string,
  limit = 8,
): T[] {
  const toks = tokens(query);
  if (toks.length === 0) return [];

  const q = toks.join(" ");
  const score = (title: string): number => {
    const t = title.toLowerCase();
    if (!toks.every((tok) => t.includes(tok))) return -1;
    if (t.startsWith(q)) return 3;
    const words = t.split(/[^a-z0-9]+/);
    if (toks.every((tok) => words.some((w) => w.startsWith(tok)))) return 2;
    return 1;
  };

  return rows
    .map((row) => ({ row, s: score(row.title) }))
    .filter(({ s }) => s >= 0)
    .sort(
      (a, b) => b.s - a.s || b.row.createdAt.localeCompare(a.row.createdAt),
    )
    .slice(0, limit)
    .map(({ row }) => row);
}
