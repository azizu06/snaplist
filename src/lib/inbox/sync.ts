import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
} from "@/lib/marketplace/messaging";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { recordPipelineRunAndMaybeAlert } from "@/lib/abuse";
import { draftBuyerReply, type DraftBuyerReplyResult } from "./reply";
import { messageRowSchema, type MessageRow, type ReplyGrounding } from "./types";

const PG_UNIQUE_VIOLATION = "23505";
const DRAFT_CLAIM_LEASE_MS = 5 * 60_000;

function configuredMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface SyncListingContext {
  itemId: string;
  listingId: string;
  title: string | null;
  grounding: ReplyGrounding;
}

export interface DraftCandidate {
  message: MessageRow;
  grounding: ReplyGrounding;
}

export interface ImportedQuestionResult {
  message: MessageRow;
  inserted: boolean;
}

/** Storage seam for the sync orchestrator; tests use a zero-network fake. */
export interface InboxSyncRepository {
  getCursor(): Promise<Date | null>;
  markAttempt(at: Date): Promise<void>;
  markSuccess(cursor: Date): Promise<void>;
  markFailure(at: Date, error: unknown): Promise<void>;
  findActiveListing(externalListingId: string): Promise<SyncListingContext | null>;
  importQuestion(
    question: MarketplaceQuestion,
    listing: SyncListingContext,
  ): Promise<ImportedQuestionResult>;
  ensureNotification(
    question: MarketplaceQuestion,
    listing: SyncListingContext,
    message: MessageRow,
  ): Promise<void>;
  listDraftCandidates(): Promise<DraftCandidate[]>;
  claimDraft(candidate: DraftCandidate, now: Date): Promise<boolean>;
  attachDraft(
    messageId: string,
    draft: DraftBuyerReplyResult,
  ): Promise<void>;
  markDraftFailed(messageId: string): Promise<void>;
}

export interface SyncInboxInput {
  adapter: MarketplaceMessagingAdapter;
  repository: InboxSyncRepository;
  now?: () => Date;
  overlapMs?: number;
  initialLookbackMs?: number;
  draft?: typeof draftBuyerReply;
  meterDraft?: () => Promise<void>;
}

export interface InboxSyncSummary {
  windowFrom: string;
  windowTo: string;
  fetched: number;
  imported: number;
  skippedUnknownListing: number;
  drafted: number;
  draftFailed: number;
}

/**
 * Shared inbox synchronization service used by foreground refresh and cron.
 *
 * The cursor advances only after every fetched question has been durably
 * mapped/imported or explicitly skipped as an unknown/non-active local listing.
 * Windows overlap by default; external identity, notification source identity,
 * and draft claims make replays harmless.
 */
export async function syncInboxForSeller(
  input: SyncInboxInput,
): Promise<InboxSyncSummary> {
  const now = input.now?.() ?? new Date();
  const cursor = await input.repository.getCursor();
  const overlapMs =
    input.overlapMs ??
    configuredMinutes("EBAY_MESSAGE_SYNC_OVERLAP_MINUTES", 10) * 60_000;
  const initialLookbackMs =
    input.initialLookbackMs ??
    configuredMinutes("EBAY_MESSAGE_INITIAL_LOOKBACK_MINUTES", 24 * 60) *
      60_000;
  const from = new Date(
    cursor
      ? cursor.getTime() - overlapMs
      : now.getTime() - initialLookbackMs,
  );

  await input.repository.markAttempt(now);
  try {
    const questions = await input.adapter.fetchUnansweredQuestions({
      from,
      to: now,
    });
    let imported = 0;
    let skippedUnknownListing = 0;

    for (const question of questions) {
      const listing = await input.repository.findActiveListing(
        question.externalListingId,
      );
      if (!listing) {
        skippedUnknownListing += 1;
        continue;
      }
      const result = await input.repository.importQuestion(question, listing);
      if (result.inserted) imported += 1;
      // Always ensure the notification on replay: a crash after the message
      // insert but before this write heals without duplicating either row.
      await input.repository.ensureNotification(
        question,
        listing,
        result.message,
      );
    }

    let drafted = 0;
    let draftFailed = 0;
    const draft = input.draft ?? draftBuyerReply;
    const meterDraft = input.meterDraft ?? recordPipelineRunAndMaybeAlert;
    for (const candidate of await input.repository.listDraftCandidates()) {
      if (!(await input.repository.claimDraft(candidate, now))) continue;
      try {
        await meterDraft();
        const result = await draft({
          question: candidate.message.body,
          grounding: candidate.grounding,
        });
        await input.repository.attachDraft(candidate.message.id, result);
        drafted += 1;
      } catch {
        await input.repository.markDraftFailed(candidate.message.id);
        draftFailed += 1;
      }
    }

    await input.repository.markSuccess(now);
    return {
      windowFrom: from.toISOString(),
      windowTo: now.toISOString(),
      fetched: questions.length,
      imported,
      skippedUnknownListing,
      drafted,
      draftFailed,
    };
  } catch (error) {
    await input.repository.markFailure(now, error).catch(() => undefined);
    throw error;
  }
}

interface ListingRow {
  id: string;
  item_id: string;
  title: string | null;
  description: string | null;
}

/** Supabase implementation; EVERY statement is explicitly pinned to userId. */
export class SupabaseInboxSyncRepository implements InboxSyncRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
  ) {}

  async getCursor(): Promise<Date | null> {
    const { data, error } = await this.supabase
      .from("ebay_message_sync_state")
      .select("cursor_at")
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read inbox sync cursor: ${error.message}`);
    if (!data?.cursor_at) return null;
    const cursor = new Date(data.cursor_at);
    return Number.isNaN(cursor.getTime()) ? null : cursor;
  }

  async markAttempt(at: Date): Promise<void> {
    const { error } = await this.supabase.from("ebay_message_sync_state").upsert(
      {
        user_id: this.userId,
        last_attempted_at: at.toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(`Failed to mark inbox sync attempt: ${error.message}`);
  }

  async markSuccess(cursor: Date): Promise<void> {
    const { error } = await this.supabase
      .from("ebay_message_sync_state")
      .update({
        cursor_at: cursor.toISOString(),
        last_succeeded_at: cursor.toISOString(),
        last_error: null,
      })
      .eq("user_id", this.userId);
    if (error) throw new Error(`Failed to advance inbox sync cursor: ${error.message}`);
  }

  async markFailure(at: Date, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Inbox sync failed";
    const { error: writeError } = await this.supabase
      .from("ebay_message_sync_state")
      .update({
        last_attempted_at: at.toISOString(),
        last_error: message.slice(0, 500),
      })
      .eq("user_id", this.userId);
    if (writeError) {
      throw new Error(`Failed to persist inbox sync failure: ${writeError.message}`);
    }
  }

  async findActiveListing(
    externalListingId: string,
  ): Promise<SyncListingContext | null> {
    const { data: listing, error } = await this.supabase
      .from("listings")
      .select("id, item_id, title, description")
      .eq("user_id", this.userId)
      .eq("platform", "ebay")
      .eq("ebay_listing_id", externalListingId)
      .eq("ebay_status", "published")
      .eq("status", "published")
      .maybeSingle<ListingRow>();
    if (error) throw new Error(`Failed to map eBay question listing: ${error.message}`);
    if (!listing) return null;

    const { data: item, error: itemError } = await this.supabase
      .from("items")
      .select("id, attributes, condition")
      .eq("user_id", this.userId)
      .eq("id", listing.item_id)
      .maybeSingle();
    if (itemError) throw new Error(`Failed to load question item: ${itemError.message}`);
    if (!item) return null;
    const parsed = extractedAttributesSchema.safeParse(item.attributes ?? {});
    const attributes = parsed.success ? parsed.data : {};
    if (!attributes.condition && item.condition) attributes.condition = item.condition;
    return {
      itemId: item.id,
      listingId: listing.id,
      title: listing.title,
      grounding: {
        attributes,
        listing: listing.title
          ? { title: listing.title, description: listing.description ?? "" }
          : null,
      },
    };
  }

  async importQuestion(
    question: MarketplaceQuestion,
    listing: SyncListingContext,
  ): Promise<ImportedQuestionResult> {
    const { data, error } = await this.supabase
      .from("messages")
      .insert({
        user_id: this.userId,
        item_id: listing.itemId,
        listing_id: listing.listingId,
        direction: "inbound",
        body: question.body,
        status: "new",
        marketplace: question.marketplace,
        external_message_id: question.externalMessageId,
        external_parent_id: question.externalParentId,
        external_conversation_id: question.externalConversationId,
        external_listing_id: question.externalListingId,
        external_buyer_id: question.externalBuyerId,
        external_created_at: question.createdAt,
      })
      .select("*")
      .maybeSingle();
    if (!error && data) {
      return { message: messageRowSchema.parse(data), inserted: true };
    }
    if (error?.code !== PG_UNIQUE_VIOLATION) {
      throw new Error(
        `Failed to import eBay question: ${error?.message ?? "no row returned"}`,
      );
    }

    const { data: existing, error: readError } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("marketplace", question.marketplace)
      .eq("external_message_id", question.externalMessageId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (readError || !existing) {
      throw new Error(
        `Failed to recover imported eBay question: ${readError?.message ?? "no row returned"}`,
      );
    }
    return { message: messageRowSchema.parse(existing), inserted: false };
  }

  async ensureNotification(
    question: MarketplaceQuestion,
    listing: SyncListingContext,
    message: MessageRow,
  ): Promise<void> {
    const { error } = await this.supabase.from("notifications").insert({
      user_id: this.userId,
      kind: "buyer_message",
      title: listing.title
        ? `New question on “${listing.title}”`
        : "New buyer question",
      body: question.body,
      href: `/inbox?c=${message.id}`,
      item_id: listing.itemId,
      listing_id: listing.listingId,
      source_message_id: message.id,
    });
    if (error && error.code !== PG_UNIQUE_VIOLATION) {
      throw new Error(`Failed to create buyer-message notification: ${error.message}`);
    }
  }

  async listDraftCandidates(): Promise<DraftCandidate[]> {
    const staleBefore = new Date(Date.now() - DRAFT_CLAIM_LEASE_MS).toISOString();
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("marketplace", "ebay")
      .eq("direction", "inbound")
      .or(
        `status.in.(new,draft_failed),and(status.eq.drafting,updated_at.lt.${staleBefore})`,
      )
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Failed to list pending reply drafts: ${error.message}`);

    const candidates: DraftCandidate[] = [];
    for (const row of data ?? []) {
      const message = messageRowSchema.parse(row);
      if (!message.item_id || !message.listing_id) continue;
      const grounding = await this.loadGrounding(message.item_id, message.listing_id);
      if (grounding) candidates.push({ message, grounding });
    }
    return candidates;
  }

  async claimDraft(candidate: DraftCandidate, now: Date): Promise<boolean> {
    let query = this.supabase
      .from("messages")
      .update({ status: "drafting", updated_at: now.toISOString() })
      .eq("user_id", this.userId)
      .eq("id", candidate.message.id);
    if (candidate.message.status === "drafting") {
      query = query.eq("status", "drafting").eq(
        "updated_at",
        candidate.message.updated_at,
      );
    } else {
      query = query.in("status", ["new", "draft_failed"]);
    }
    const { data, error } = await query.select("id");
    if (error) throw new Error(`Failed to claim reply draft: ${error.message}`);
    return (data?.length ?? 0) === 1;
  }

  async attachDraft(
    messageId: string,
    draft: DraftBuyerReplyResult,
  ): Promise<void> {
    const { data, error } = await this.supabase
      .from("messages")
      .update({
        draft_reply: draft.reply,
        draft_model: draft.usedFallback ? `${draft.model} (fallback)` : draft.model,
        status: "drafted",
      })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("status", "drafting")
      .select("id");
    if (error || data?.length !== 1) {
      throw new Error(`Failed to attach imported reply draft: ${error?.message ?? "claim lost"}`);
    }
  }

  async markDraftFailed(messageId: string): Promise<void> {
    const { error } = await this.supabase
      .from("messages")
      .update({ status: "draft_failed" })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("status", "drafting");
    if (error) throw new Error(`Failed to mark imported draft failed: ${error.message}`);
  }

  private async loadGrounding(
    itemId: string,
    listingId: string,
  ): Promise<ReplyGrounding | null> {
    const [{ data: item }, { data: listing }] = await Promise.all([
      this.supabase
        .from("items")
        .select("attributes, condition")
        .eq("user_id", this.userId)
        .eq("id", itemId)
        .maybeSingle(),
      this.supabase
        .from("listings")
        .select("title, description")
        .eq("user_id", this.userId)
        .eq("id", listingId)
        .maybeSingle(),
    ]);
    if (!item || !listing) return null;
    const parsed = extractedAttributesSchema.safeParse(item.attributes ?? {});
    const attributes = parsed.success ? parsed.data : {};
    if (!attributes.condition && item.condition) attributes.condition = item.condition;
    return {
      attributes,
      listing: listing.title
        ? { title: listing.title, description: listing.description ?? "" }
        : null,
    };
  }
}
