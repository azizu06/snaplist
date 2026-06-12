/**
 * Date formatting for the dashboard's Created column: relative within the
 * last week ("Today", "3d ago" — the question is "when did I list this"),
 * a short absolute date beyond that. Calendar-day based, not 24h windows,
 * so 11pm yesterday is still "Yesterday" at 9am.
 */
export function relativeDay(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
