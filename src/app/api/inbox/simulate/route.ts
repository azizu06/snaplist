import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import {
  attachDraftReply,
  createBuyerMessage,
  draftBuyerReply,
  markDraftFailed,
  simulateBuyerQuestion,
  type ReplyGrounding,
} from "@/lib/inbox";

/**
 * POST /api/inbox/simulate — simulate an incoming buyer question for one of the
 * caller's items (issue #13; v1 has no real buyer traffic).
 *
 * Flow (each persisted step rides Realtime to the live inbox — no refresh):
 *   1. Load the item + its latest listing through the USER-SCOPED client, so RLS
 *      proves ownership (another user's itemId 404s — never leaks).
 *   2. Generate a plausible buyer question grounded in the item's real facts.
 *   3. Persist it as an inbound `new` message  → Realtime INSERT (the question
 *      appears live).
 *   4. Run the reply agent (grounded in attributes + listing copy; falls back
 *      deterministically — never throws) and attach the draft → Realtime UPDATE
 *      (the draft appears under the question).
 */

const bodySchema = z.object({
  itemId: z.uuid(),
  /**
   * Recovery path: re-draft an EXISTING inbound message (status `new` or
   * `draft_failed`) instead of creating another one. This is what makes a
   * draft that crashed after the insert recoverable — repeating the plain
   * simulation would only pile up new questions.
   */
  messageId: z.uuid().optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "itemId (uuid) is required" },
      { status: 400 },
    );
  }
  const { itemId, messageId } = parsed.data;

  // RLS scopes the read: a non-owned / missing id returns no row → 404.
  const { data: item } = await supabase
    .from("items")
    .select("id, attributes, condition")
    .eq("id", itemId)
    .maybeSingle();
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const { data: listing } = await supabase
    .from("listings")
    .select("id, title, description")
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // The grounding: the item's VALIDATED attribute core + the generated listing
  // copy — the only facts the question targets and the reply agent may use.
  const attrsParse = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const attributes = attrsParse.success ? attrsParse.data : {};
  if (!attributes.condition && item.condition) {
    attributes.condition = item.condition;
  }
  const grounding: ReplyGrounding = {
    attributes,
    listing:
      listing?.title != null
        ? { title: listing.title, description: listing.description ?? "" }
        : null,
  };

  // --- Recovery: re-draft an existing message instead of creating one. -----
  if (messageId !== undefined) {
    // RLS scopes the read; only an undrafted inbound row may be re-drafted —
    // a drafted/sent message is never clobbered.
    const { data: existing } = await supabase
      .from("messages")
      .select("id, body, status, direction")
      .eq("id", messageId)
      .eq("item_id", itemId)
      .maybeSingle();
    if (!existing || existing.direction !== "inbound") {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }
    if (existing.status !== "new" && existing.status !== "draft_failed") {
      return NextResponse.json(
        { error: `Message is already ${existing.status}` },
        { status: 409 },
      );
    }
    try {
      const draft = await draftBuyerReply({ question: existing.body, grounding });
      await attachDraftReply(supabase, {
        messageId: existing.id,
        draft: draft.reply,
        model: draft.usedFallback ? `${draft.model} (fallback)` : draft.model,
      });
      return NextResponse.json(
        { messageId: existing.id, status: "drafted" },
        { status: 200 },
      );
    } catch (err) {
      await markDraftFailed(supabase, existing.id);
      const message = err instanceof Error ? err.message : "Draft failed";
      return NextResponse.json(
        { messageId: existing.id, status: "draft_failed", error: message },
        { status: 500 },
      );
    }
  }

  const question = simulateBuyerQuestion(grounding);

  // Inbound first: the question must land (and stream) even if drafting fails.
  let message;
  try {
    message = await createBuyerMessage(supabase, {
      userId: user.id,
      itemId,
      listingId: listing?.id ?? null,
      body: question,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Simulation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    // The agent never throws (deterministic grounded fallback), so the message
    // always ends up `drafted` with something safe for the seller to edit.
    const draft = await draftBuyerReply({ question, grounding });
    await attachDraftReply(supabase, {
      messageId: message.id,
      draft: draft.reply,
      model: draft.usedFallback ? `${draft.model} (fallback)` : draft.model,
    });

    return NextResponse.json(
      { messageId: message.id, status: "drafted" },
      { status: 201 },
    );
  } catch (err) {
    // The inbound row exists but its draft crashed (model call, serverless
    // interrupt, update failure). Persist the explicit failure state so the
    // inbox renders a RETRYABLE failure instead of "drafting…" forever; the
    // messageId in the response (and the row itself) feeds the recovery path.
    await markDraftFailed(supabase, message.id);
    const msg = err instanceof Error ? err.message : "Simulation failed";
    return NextResponse.json(
      { messageId: message.id, status: "draft_failed", error: msg },
      { status: 500 },
    );
  }
}
