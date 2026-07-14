import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
  MarketplaceQuestionResolutionFailure,
  PendingMarketplaceQuestion,
} from "@/lib/marketplace/messaging";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { recordPipelineRunAndMaybeAlert } from "@/lib/abuse";
import { draftBuyerReply, type DraftBuyerReplyResult } from "./reply";
import {
  applyEbayMessageWrite,
  applyScheduledEbayMessageWrite,
  beginEbayMessageWrite,
  beginScheduledEbayMessageWrite,
  readScheduledEbayInbox,
} from "./ebay-server-write";
import { messageRowSchema, type MessageRow, type ReplyGrounding } from "./types";

const DRAFT_CLAIM_LEASE_MS = 5 * 60_000;
const MINIMUM_RECONCILIATION_LOOKBACK_MS = 24 * 60 * 60_000;

function configuredMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pendingReconciliationAt(
  pending: PendingMarketplaceQuestion,
): number {
  const createdAt = pending.createdAt ? Date.parse(pending.createdAt) : NaN;
  return Number.isFinite(createdAt)
    ? createdAt
    : Date.parse(pending.resolutionWindowFrom);
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

export interface ActionableQuestionIdentity {
  externalMessageId: string;
  createdAt: string;
}

/** Storage seam for the sync orchestrator; tests use a zero-network fake. */
export interface InboxSyncRepository {
  getCursor(): Promise<Date | null>;
  markAttempt(at: Date): Promise<void>;
  markSuccess(cursor: Date, pendingResolutionCount: number): Promise<void>;
  markFailure(at: Date, error: unknown): Promise<void>;
  listPendingQuestions(): Promise<PendingMarketplaceQuestion[]>;
  upsertPendingQuestion(
    failure: MarketplaceQuestionResolutionFailure,
    attemptedAt: Date,
  ): Promise<void>;
  markPendingResolutionFailed(
    externalMessageId: string,
    attemptedAt: Date,
    error: unknown,
  ): Promise<void>;
  removePendingQuestion(externalMessageId: string): Promise<void>;
  retirePendingQuestion(
    externalMessageId: string,
    outcome: "externally_answered" | "provider_unavailable",
    at: Date,
  ): Promise<void>;
  countPendingQuestions(): Promise<number>;
  listActionableQuestions(): Promise<ActionableQuestionIdentity[]>;
  markExternallyAnswered(externalMessageId: string, at: Date): Promise<void>;
  markProviderUnavailable(externalMessageId: string, at: Date): Promise<void>;
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
  pendingResolution: number;
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
  const overlapMs = Math.max(
    input.overlapMs ??
      configuredMinutes("EBAY_MESSAGE_SYNC_OVERLAP_MINUTES", 24 * 60) *
        60_000,
    MINIMUM_RECONCILIATION_LOOKBACK_MS,
  );
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
    const pendingBeforeFetch = await input.repository.listPendingQuestions();
    const actionableBeforeFetch = await input.repository.listActionableQuestions();
    const fetched = await input.adapter.fetchUnansweredQuestions({
      from,
      to: now,
    });
    const reconcilableBeforeFetch = actionableBeforeFetch.filter((actionable) => {
      const createdAt = Date.parse(actionable.createdAt);
      return Number.isFinite(createdAt) && createdAt <= now.getTime();
    });
    const pendingOutsideFetch = pendingBeforeFetch.filter((pending) => {
      const reconciliationAt = pendingReconciliationAt(pending);
      return (
        Number.isFinite(reconciliationAt) && reconciliationAt < from.getTime()
      );
    });
    const actionableIds = new Set(
      reconcilableBeforeFetch.map(({ externalMessageId }) => externalMessageId),
    );
    const pendingIds = new Set(
      pendingBeforeFetch.map(({ externalMessageId }) => externalMessageId),
    );
    const historicalTrackedIds = new Set([...actionableIds, ...pendingIds]);
    const oldestReconciliationAt = [
      ...reconcilableBeforeFetch.map(({ createdAt }) => Date.parse(createdAt)),
      ...pendingOutsideFetch.map(pendingReconciliationAt),
    ].reduce<number | null>((oldest, reconciliationAt) => {
      if (!Number.isFinite(reconciliationAt)) return oldest;
      return oldest === null
        ? reconciliationAt
        : Math.min(oldest, reconciliationAt);
    }, null);
    const reconciliationFetched =
      oldestReconciliationAt !== null && oldestReconciliationAt < from.getTime()
        ? await input.adapter.fetchUnansweredQuestions({
            from: new Date(oldestReconciliationAt),
            to: from,
          })
        : null;
    let imported = 0;
    let skippedUnknownListing = 0;

    const processQuestion = async (question: MarketplaceQuestion) => {
      const listing = await input.repository.findActiveListing(
        question.externalListingId,
      );
      if (!listing) {
        skippedUnknownListing += 1;
        await input.repository.removePendingQuestion(question.externalMessageId);
        return;
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
      await input.repository.removePendingQuestion(question.externalMessageId);
    };

    for (const failure of fetched.unresolved) {
      await input.repository.upsertPendingQuestion(failure, now);
    }
    for (const failure of reconciliationFetched?.unresolved ?? []) {
      if (pendingIds.has(failure.question.externalMessageId)) {
        await input.repository.upsertPendingQuestion(failure, now);
      }
    }
    for (const question of fetched.questions) {
      await processQuestion(question);
    }

    const historicalResolved = new Map(
      (reconciliationFetched?.questions ?? [])
        .filter((candidate) => pendingIds.has(candidate.externalMessageId))
        .map((candidate) => [candidate.externalMessageId, candidate]),
    );
    const observedIds = new Set([
      ...fetched.questions.map((question) => question.externalMessageId),
      ...fetched.unresolved.map(({ question }) => question.externalMessageId),
      ...(reconciliationFetched?.questions ?? [])
        .map((candidate) => candidate.externalMessageId)
        .filter((externalMessageId) => historicalTrackedIds.has(externalMessageId)),
      ...(reconciliationFetched?.unresolved ?? [])
        .map(({ question: candidate }) => candidate.externalMessageId)
        .filter((externalMessageId) => historicalTrackedIds.has(externalMessageId)),
      ...fetched.answeredExternalMessageIds,
      ...(reconciliationFetched?.answeredExternalMessageIds ?? []).filter(
        (externalMessageId) => historicalTrackedIds.has(externalMessageId),
      ),
    ]);
    const answeredIds = new Set([
      ...fetched.answeredExternalMessageIds,
      ...(reconciliationFetched?.answeredExternalMessageIds ?? []),
    ]);
    for (const { externalMessageId } of reconcilableBeforeFetch) {
      if (answeredIds.has(externalMessageId)) {
        await input.repository.markExternallyAnswered(externalMessageId, now);
      } else if (!observedIds.has(externalMessageId)) {
        await input.repository.markProviderUnavailable(externalMessageId, now);
      }
    }
    for (const pending of pendingBeforeFetch) {
      const resolved = historicalResolved.get(pending.externalMessageId);
      if (resolved) {
        await processQuestion(resolved);
        continue;
      }
      if (answeredIds.has(pending.externalMessageId)) {
        await input.repository.retirePendingQuestion(
          pending.externalMessageId,
          "externally_answered",
          now,
        );
        continue;
      }
      if (observedIds.has(pending.externalMessageId)) continue;
      const pendingCreatedAt = pendingReconciliationAt(pending);
      if (
        Number.isFinite(pendingCreatedAt) &&
        pendingCreatedAt >= (oldestReconciliationAt ?? from.getTime()) &&
        pendingCreatedAt <= now.getTime()
      ) {
        await input.repository.retirePendingQuestion(
          pending.externalMessageId,
          "provider_unavailable",
          now,
        );
        continue;
      }
      try {
        await processQuestion(await input.adapter.resolveQuestion(pending));
      } catch (error) {
        await input.repository.markPendingResolutionFailed(
          pending.externalMessageId,
          now,
          error,
        );
      }
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

    const pendingResolution = await input.repository.countPendingQuestions();
    await input.repository.markSuccess(now, pendingResolution);
    return {
      windowFrom: from.toISOString(),
      windowTo: now.toISOString(),
      fetched: fetched.questions.length + fetched.unresolved.length,
      imported,
      skippedUnknownListing,
      drafted,
      draftFailed,
      pendingResolution,
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

interface PendingQuestionRow {
  external_message_id: string;
  external_parent_id: string;
  external_listing_id: string;
  external_buyer_id: string | null;
  body: string | null;
  subject: string | null;
  external_created_at: string | null;
  resolution_window_from: string;
  observed_cursor_at: string;
}

/** Supabase implementation; EVERY statement is explicitly pinned to userId. */
export class SupabaseInboxSyncRepository implements InboxSyncRepository {
  private writeGeneration: Promise<string> | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
    private readonly writeTarget: {
      client: SupabaseClient;
      scheduled: boolean;
    } = { client: supabase, scheduled: false },
  ) {}

  private getWriteGeneration(): Promise<string> {
    this.writeGeneration ??= this.writeTarget.scheduled
      ? beginScheduledEbayMessageWrite(this.writeTarget.client, this.userId)
      : beginEbayMessageWrite(this.writeTarget.client);
    return this.writeGeneration;
  }

  private async applyWrite<T>(
    operation: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const generation = await this.getWriteGeneration();
    return this.writeTarget.scheduled
      ? applyScheduledEbayMessageWrite<T>(
          this.writeTarget.client,
          this.userId,
          operation,
          payload,
          generation,
        )
      : applyEbayMessageWrite<T>(
          this.writeTarget.client,
          operation,
          payload,
          generation,
        );
  }

  private async readScheduled<T>(
    operation: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    return readScheduledEbayInbox<T>(
      this.writeTarget.client,
      this.userId,
      operation,
      payload,
    );
  }

  async getCursor(): Promise<Date | null> {
    if (this.writeTarget.scheduled) {
      await this.getWriteGeneration();
      const data = await this.readScheduled<{ cursor_at: string | null } | null>(
        "cursor",
      );
      if (!data?.cursor_at) return null;
      const cursor = new Date(data.cursor_at);
      return Number.isNaN(cursor.getTime()) ? null : cursor;
    }
    const generation = await this.getWriteGeneration();
    const { data, error } = await this.supabase
      .from("ebay_message_sync_state")
      .select("cursor_at")
      .eq("user_id", this.userId)
      .eq("ebay_account_generation", generation)
      .maybeSingle();
    if (error) throw new Error(`Failed to read inbox sync cursor: ${error.message}`);
    if (!data?.cursor_at) return null;
    const cursor = new Date(data.cursor_at);
    return Number.isNaN(cursor.getTime()) ? null : cursor;
  }

  async markAttempt(at: Date): Promise<void> {
    await this.applyWrite("sync_mark_attempt", { at: at.toISOString() });
  }

  async markSuccess(
    cursor: Date,
    pendingResolutionCount: number,
  ): Promise<void> {
    await this.applyWrite("sync_mark_success", {
      at: cursor.toISOString(),
      pending_resolution_count: pendingResolutionCount,
    });
  }

  async markFailure(at: Date, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Inbox sync failed";
    await this.applyWrite("sync_mark_failure", {
      at: at.toISOString(),
      error: message.slice(0, 500),
    });
  }

  async listPendingQuestions(): Promise<PendingMarketplaceQuestion[]> {
    const generation = await this.getWriteGeneration();
    const result = this.writeTarget.scheduled
      ? { data: await this.readScheduled<unknown[]>("pending_questions"), error: null }
      : await this.supabase
          .from("ebay_unresolved_questions")
          .select(
            "external_message_id, external_parent_id, external_listing_id, external_buyer_id, body, subject, external_created_at, resolution_window_from, observed_cursor_at",
          )
          .eq("user_id", this.userId)
          .eq("ebay_account_generation", generation)
          .eq("resolution_status", "pending")
          .order("last_resolution_attempted_at", { ascending: true })
          .order("external_created_at", { ascending: true })
          .limit(50);
    const { data, error } = result;
    if (error) {
      throw new Error(`Failed to list unresolved eBay questions: ${error.message}`);
    }
    return ((data ?? []) as PendingQuestionRow[]).map((row) => ({
      marketplace: "ebay" as const,
      externalMessageId: row.external_message_id as string,
      externalParentId: row.external_parent_id as string,
      externalListingId: row.external_listing_id as string,
      externalBuyerId: (row.external_buyer_id as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      subject: (row.subject as string | null) ?? null,
      createdAt:
        typeof row.external_created_at === "string"
          ? new Date(row.external_created_at).toISOString()
          : null,
      resolutionWindowFrom: new Date(
        row.resolution_window_from as string,
      ).toISOString(),
      observedCursorAt: new Date(row.observed_cursor_at as string).toISOString(),
    }));
  }

  async upsertPendingQuestion(
    failure: MarketplaceQuestionResolutionFailure,
    attemptedAt: Date,
  ): Promise<void> {
    await this.applyWrite("upsert_unresolved_question", {
      external_message_id: failure.question.externalMessageId,
      external_parent_id: failure.question.externalParentId,
      external_listing_id: failure.question.externalListingId,
      external_buyer_id: failure.question.externalBuyerId,
      body: failure.question.body,
      subject: failure.question.subject,
      external_created_at: failure.question.createdAt,
      resolution_window_from: failure.question.resolutionWindowFrom,
      observed_cursor_at: failure.question.observedCursorAt,
      attempted_at: attemptedAt.toISOString(),
      error: failure.error.slice(0, 500),
    });
  }

  async markPendingResolutionFailed(
    externalMessageId: string,
    attemptedAt: Date,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Conversation resolution failed";
    await this.applyWrite("mark_unresolved_question_failed", {
      external_message_id: externalMessageId,
      attempted_at: attemptedAt.toISOString(),
      error: message.slice(0, 500),
    });
  }

  async removePendingQuestion(externalMessageId: string): Promise<void> {
    await this.applyWrite("remove_unresolved_question", {
      external_message_id: externalMessageId,
    });
  }

  async retirePendingQuestion(
    externalMessageId: string,
    outcome: "externally_answered" | "provider_unavailable",
    at: Date,
  ): Promise<void> {
    await this.applyWrite("retire_unresolved_question", {
      external_message_id: externalMessageId,
      outcome,
      at: at.toISOString(),
    });
  }

  async countPendingQuestions(): Promise<number> {
    if (this.writeTarget.scheduled) {
      return this.readScheduled<number>("pending_count");
    }
    const generation = await this.getWriteGeneration();
    const { count, error } = await this.supabase
      .from("ebay_unresolved_questions")
      .select("external_message_id", { count: "exact", head: true })
      .eq("user_id", this.userId)
      .eq("ebay_account_generation", generation)
      .eq("resolution_status", "pending");
    if (error) {
      throw new Error(`Failed to count unresolved eBay questions: ${error.message}`);
    }
    return count ?? 0;
  }

  async listActionableQuestions(): Promise<ActionableQuestionIdentity[]> {
    if (this.writeTarget.scheduled) {
      return this.readScheduled<ActionableQuestionIdentity[]>(
        "actionable_questions",
      );
    }
    const generation = await this.getWriteGeneration();
    const { data, error } = await this.supabase
      .from("messages")
      .select("id, external_message_id, external_created_at")
      .eq("user_id", this.userId)
      .eq("ebay_account_generation", generation)
      .eq("marketplace", "ebay")
      .eq("direction", "inbound")
      .in("status", ["new", "drafting", "drafted", "draft_failed", "sent"])
      .not("external_message_id", "is", null)
      .not("external_created_at", "is", null);
    if (error) {
      throw new Error(`Failed to list actionable eBay questions: ${error.message}`);
    }
    const candidates = data ?? [];
    if (candidates.length === 0) return [];
    const { data: delivered, error: deliveredError } = await this.supabase
      .from("messages")
      .select("reply_to")
      .eq("user_id", this.userId)
      .eq("ebay_account_generation", generation)
      .eq("marketplace", "ebay")
      .eq("direction", "outbound")
      .eq("delivery_status", "delivered")
      .not("external_delivery_id", "is", null)
      .in("reply_to", candidates.map((row) => row.id))
      .or("reply_kind.is.null,reply_kind.eq.reply");
    if (deliveredError) {
      throw new Error(
        `Failed to verify delivered eBay questions: ${deliveredError.message}`,
      );
    }
    const deliveredRoots = new Set(
      (delivered ?? []).flatMap((row) =>
        typeof row.reply_to === "string" ? [row.reply_to] : [],
      ),
    );
    return candidates.flatMap((row) => {
      if (
        deliveredRoots.has(row.id) ||
        typeof row.external_message_id !== "string" ||
        typeof row.external_created_at !== "string"
      ) {
        return [];
      }
      return [
        {
          externalMessageId: row.external_message_id,
          createdAt: row.external_created_at,
        },
      ];
    });
  }

  async markExternallyAnswered(
    externalMessageId: string,
    at: Date,
  ): Promise<void> {
    await this.applyWrite("mark_externally_answered", {
      external_message_id: externalMessageId,
      at: at.toISOString(),
    });
  }

  async markProviderUnavailable(
    externalMessageId: string,
    at: Date,
  ): Promise<void> {
    await this.applyWrite("mark_provider_unavailable", {
      external_message_id: externalMessageId,
      at: at.toISOString(),
    });
  }

  async findActiveListing(
    externalListingId: string,
  ): Promise<SyncListingContext | null> {
    if (this.writeTarget.scheduled) {
      const data = await this.readScheduled<{
        item_id: string;
        listing_id: string;
        title: string | null;
        description: string | null;
        attributes: unknown;
        condition: string | null;
      } | null>("active_listing", { external_listing_id: externalListingId });
      if (!data) return null;
      const parsed = extractedAttributesSchema.safeParse(data.attributes ?? {});
      const attributes = parsed.success ? parsed.data : {};
      if (!attributes.condition && data.condition) {
        attributes.condition = data.condition;
      }
      return {
        itemId: data.item_id,
        listingId: data.listing_id,
        title: data.title,
        grounding: {
          attributes,
          listing: data.title
            ? { title: data.title, description: data.description ?? "" }
            : null,
        },
      };
    }
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
    const result = await this.applyWrite<{
      message: unknown;
      inserted: boolean;
    }>("import_question", {
      item_id: listing.itemId,
      listing_id: listing.listingId,
      body: question.body,
      external_message_id: question.externalMessageId,
      external_parent_id: question.externalParentId,
      external_conversation_id: question.externalConversationId,
      external_listing_id: question.externalListingId,
      external_buyer_id: question.externalBuyerId,
      external_created_at: question.createdAt,
    });
    return {
      message: messageRowSchema.parse(result.message),
      inserted: result.inserted,
    };
  }

  async ensureNotification(
    _question: MarketplaceQuestion,
    _listing: SyncListingContext,
    message: MessageRow,
  ): Promise<void> {
    await this.applyWrite("ensure_notification", { message_id: message.id });
  }

  async listDraftCandidates(): Promise<DraftCandidate[]> {
    const staleBefore = new Date(Date.now() - DRAFT_CLAIM_LEASE_MS).toISOString();
    if (this.writeTarget.scheduled) {
      const data = await this.readScheduled<
        Array<{
          message: unknown;
          attributes: unknown;
          condition: string | null;
          listing_title: string | null;
          listing_description: string | null;
        }>
      >("draft_candidates", { stale_before: staleBefore });
      return data.map((row) => {
        const message = messageRowSchema.parse(row.message);
        const parsed = extractedAttributesSchema.safeParse(row.attributes ?? {});
        const attributes = parsed.success ? parsed.data : {};
        if (!attributes.condition && row.condition) {
          attributes.condition = row.condition;
        }
        return {
          message,
          grounding: {
            attributes,
            listing: row.listing_title
              ? {
                  title: row.listing_title,
                  description: row.listing_description ?? "",
                }
              : null,
          },
        };
      });
    }
    const generation = await this.getWriteGeneration();
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("ebay_account_generation", generation)
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
    return this.applyWrite<boolean>("claim_draft", {
      message_id: candidate.message.id,
      expected_status: candidate.message.status,
      expected_updated_at: candidate.message.updated_at,
      at: now.toISOString(),
    });
  }

  async attachDraft(
    messageId: string,
    draft: DraftBuyerReplyResult,
  ): Promise<void> {
    await this.applyWrite("attach_draft", {
      message_id: messageId,
      draft_reply: draft.reply,
      draft_model: draft.usedFallback ? `${draft.model} (fallback)` : draft.model,
    });
  }

  async markDraftFailed(messageId: string): Promise<void> {
    await this.applyWrite("mark_draft_failed", { message_id: messageId });
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
