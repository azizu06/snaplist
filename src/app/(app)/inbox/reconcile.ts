import type { MessageAttachmentRow } from "@/lib/inbox";

export function reconcileAttachments(
  prev: MessageAttachmentRow[],
  fetched: MessageAttachmentRow[],
): MessageAttachmentRow[] {
  const byId = new Map(fetched.map((row) => [row.id, row] as const));
  for (const row of prev) {
    const snapshot = byId.get(row.id);
    if (!snapshot || snapshot.updated_at.localeCompare(row.updated_at) < 0) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}
