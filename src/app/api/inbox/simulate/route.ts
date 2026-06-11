import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import {
  attachDraftReply,
  createBuyerMessage,
  draftBuyerReply,
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

const bodySchema = z.object({ itemId: z.uuid() });

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
  const { itemId } = parsed.data;

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

  const question = simulateBuyerQuestion(grounding);

  try {
    // Inbound first: the question must land (and stream) even if drafting fails.
    const message = await createBuyerMessage(supabase, {
      userId: user.id,
      itemId,
      listingId: listing?.id ?? null,
      body: question,
    });

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
    const message = err instanceof Error ? err.message : "Simulation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
