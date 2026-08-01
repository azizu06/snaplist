import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadExportHandoffs,
  markExportShared,
  recordExportHandoff,
} from "./handoff";

/**
 * Assisted-export handoff seam (issue #378). Fully OFFLINE: a minimal fake
 * Supabase client covering just the surface this helper touches.
 *
 * The invariant under test: SnapList cannot observe Facebook Marketplace,
 * Mercari, or Depop. Preparing a pack and handing it over prove nothing about
 * whether a listing went up, so only the seller's explicit confirmation may
 * ever produce `shared`, and a rejected confirmation must surface as a failure
 * rather than an optimistic local state.
 */

const ITEM_ID = "6ac6d4a1-63b1-4a3e-9d5a-7b2e2d0f1c11";
const CONTENT_REVISION = "1f0d5f6f-2b6c-4a1d-8a54-2f3f1c1c9a01";
const REVIEW_REVISION = "8b3a6d2e-9c1a-4b77-9a02-0c5b7a4e6d02";

interface HandoffRow {
  platform: string;
  handoff_at: string | null;
  shared_at: string | null;
}

function fakeSupabase(
  rows: HandoffRow[],
  calls: { name: string; args: Record<string, unknown> }[] = [],
  rpcError: { message: string } | null = null,
  rpcData: unknown = null,
): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "export_handoffs") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: rows, error: null }),
          }),
        }),
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: rpcData, error: rpcError };
    },
  } as unknown as SupabaseClient;
}

describe("assisted export handoffs", () => {
  it("reports every destination as prepared until the seller confirms it", async () => {
    const view = await loadExportHandoffs(
      fakeSupabase([
        // handed over, but the seller has not said they posted it
        { platform: "facebook", handoff_at: "2026-07-31T04:00:00Z", shared_at: null },
        {
          platform: "mercari",
          handoff_at: "2026-07-31T04:00:00Z",
          shared_at: "2026-07-31T04:05:00Z",
        },
      ]),
      { itemId: ITEM_ID, reviewContentRevision: CONTENT_REVISION },
    );

    expect(view.facebook.state).toBe("prepared");
    expect(view.facebook.handedOffAt).toBe("2026-07-31T04:00:00Z");
    expect(view.mercari.state).toBe("shared");
    // no row at all is still prepared — never "not started" or "failed"
    expect(view.depop.state).toBe("prepared");
    expect(view.depop.handedOffAt).toBeNull();
    expect(view.depop.sharedAt).toBeNull();
  });

  it("sends both revisions with a confirmation so a stale pack fails closed", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await markExportShared(
      fakeSupabase([], calls, null, "2026-07-31T04:05:00Z"),
      {
        itemId: ITEM_ID,
        platform: "depop",
        reviewContentRevision: CONTENT_REVISION,
        reviewRevision: REVIEW_REVISION,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("mark_export_shared");
    expect(calls[0]!.args).toEqual({
      p_item_id: ITEM_ID,
      p_platform: "depop",
      p_source_review_revision: CONTENT_REVISION,
      p_expected_review_revision: REVIEW_REVISION,
    });
  });

  it("surfaces a refused confirmation instead of claiming the listing is shared", async () => {
    await expect(
      markExportShared(
        fakeSupabase([], [], {
          message: "This listing changed. Reopen the export pack and try again.",
        }),
        {
          itemId: ITEM_ID,
          platform: "facebook",
          reviewContentRevision: CONTENT_REVISION,
          reviewRevision: REVIEW_REVISION,
        },
      ),
    ).rejects.toThrow(/listing changed/i);
  });

  it("keeps the refusal code so a stale pack is distinguishable from a bad destination", async () => {
    // `P0002` is "reopen the sheet and try again"; `22023` can never succeed.
    // A caller that only sees the message cannot tell those apart.
    await expect(
      markExportShared(
        fakeSupabase([], [], {
          message: "This listing changed. Reopen the export pack and try again.",
          code: "P0002",
        } as { message: string }),
        {
          itemId: ITEM_ID,
          platform: "depop",
          reviewContentRevision: CONTENT_REVISION,
          reviewRevision: REVIEW_REVISION,
        },
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("refuses to report Shared when the capability returned no receipt", async () => {
    // No error and no timestamp means the guarded update matched nothing. A
    // caller must never paint `Shared` over a write that did not happen.
    await expect(
      markExportShared(fakeSupabase([], [], null, null), {
        itemId: ITEM_ID,
        platform: "mercari",
        reviewContentRevision: CONTENT_REVISION,
        reviewRevision: REVIEW_REVISION,
      }),
    ).rejects.toThrow(/no timestamp/i);
  });

  it("refuses to record an assisted handoff for a directly published marketplace", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await expect(
      recordExportHandoff(fakeSupabase([], calls), {
        itemId: ITEM_ID,
        // eBay is a transactional adapter, never an assisted destination.
        platform: "ebay" as never,
        reviewContentRevision: CONTENT_REVISION,
        reviewRevision: REVIEW_REVISION,
      }),
    ).rejects.toThrow(/assisted/i);
    expect(calls).toHaveLength(0);
  });
});
