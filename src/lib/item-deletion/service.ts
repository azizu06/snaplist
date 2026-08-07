import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Non-guest item deletion (issue #181).
 *
 * The capability lives in `public.delete_item`, not here. That executor is the
 * only door: the direct `items` delete policy was removed in the same migration
 * precisely so a client cannot cascade the item graph out from under a running
 * pipeline, an in-flight publish, or a raw voice asset whose deletion proof has
 * not been written yet.
 *
 * So this module transports a decision it does not make. Its one real
 * obligation is to keep two outcomes distinguishable that a naive caller would
 * flatten together: SnapList deleted the item, and SnapList refused to. A
 * refusal returns `status: 'blocked'` — a successful RPC call with an
 * unsuccessful answer — and reading only `error` would report a deletion that
 * never happened.
 */

/** What the executor kept, and why the seller was told about it. */
export interface ItemDeletionReceipt {
  status: "deleted";
  itemId: string;
  /**
   * Records SnapList could not delete because it does not own them. The live
   * eBay listing is the launch case: ending it is the seller's action on eBay,
   * and reporting deletion of an item whose listing is still live would be a
   * false claim about the provider.
   */
  retainedRecords: string[];
}

/**
 * The item still exists. `blockedBy` names an operation in flight, so the
 * seller can retry once it settles — this is not a permission failure and must
 * not be reported as one.
 */
export class ItemDeletionBlockedError extends Error {
  readonly blockedBy: string[];

  constructor(blockedBy: string[]) {
    super(`Item deletion is blocked: ${blockedBy.join(", ")}`);
    this.name = "ItemDeletionBlockedError";
    this.blockedBy = blockedBy;
  }
}

/**
 * The item is not the caller's, or does not exist. RLS makes these one and the
 * same fact to a tenant, and the executor deliberately answers both the same
 * way: an owner-specific "forbidden" would confirm another tenant's item id.
 */
export class ItemDeletionNotFoundError extends Error {
  constructor() {
    super("Item was not found");
    this.name = "ItemDeletionNotFoundError";
  }
}

const deletionOutcomeSchema = z
  .object({
    status: z.enum(["deleted", "blocked"]),
    item_id: z.string().uuid(),
    blocked_by: z.array(z.string().min(1)),
    retained_records: z.array(z.string().min(1)),
  })
  .strict();

/** Postgres raises this when the item is absent from the caller's tenant. */
const ITEM_NOT_FOUND = "P0002";

/**
 * Deletes one item through the executor on a client scoped to the caller's own
 * bearer. There is no service-role path: a seller deleting their own item is an
 * ordinary tenant operation, and routing it around RLS would only remove the
 * check that makes it safe.
 */
export async function deleteItem(
  supabase: SupabaseClient,
  input: { itemId: string },
): Promise<ItemDeletionReceipt> {
  const { data, error } = await supabase.rpc("delete_item", {
    p_item_id: input.itemId,
  });

  if (error) {
    if (error.code === ITEM_NOT_FOUND) throw new ItemDeletionNotFoundError();
    throw error;
  }

  const outcome = deletionOutcomeSchema.parse(data);
  if (outcome.status === "blocked") {
    throw new ItemDeletionBlockedError(outcome.blocked_by);
  }

  return {
    status: "deleted",
    itemId: outcome.item_id,
    retainedRecords: outcome.retained_records,
  };
}
