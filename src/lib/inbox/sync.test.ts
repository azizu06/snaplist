import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { MockMarketplaceMessagingAdapter } from "@/lib/marketplace/mock-messaging";
import type {
  MarketplaceQuestion,
  MarketplaceQuestionResolutionFailure,
  PendingMarketplaceQuestion,
} from "@/lib/marketplace/messaging";
import type { MessageRow, ReplyGrounding } from "./types";
import {
  syncInboxForSeller,
  SupabaseInboxSyncRepository,
  type DraftCandidate,
  type InboxSyncRepository,
  type ImportedQuestionResult,
  type SyncListingContext,
} from "./sync";

const USER_ID = "user_tenant_a";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const grounding: ReplyGrounding = {
  attributes: { brand: "Sony", model: "WH-1000XM5", category: "Headphones" },
  listing: { title: "Sony WH-1000XM5", description: "Includes charger." },
};

const listing: SyncListingContext = {
  itemId: ITEM_ID,
  listingId: LISTING_ID,
  title: "Sony WH-1000XM5",
  grounding,
};

const question: MarketplaceQuestion = {
  marketplace: "ebay",
  externalMessageId: "ebay-question-42",
  externalParentId: "ebay-question-42",
  externalConversationId: "commerce-conversation-9",
  externalListingId: "110011001100",
  externalBuyerId: "buyer-public-id",
  body: "Does it include the charger?",
  subject: "Question about item",
  createdAt: "2026-07-13T12:04:00.000Z",
};

class MemorySyncRepository implements InboxSyncRepository {
  cursor: Date | null = null;
  attempts: string[] = [];
  successes: string[] = [];
  failures: string[] = [];
  pendingResolutionCounts: number[] = [];
  pending = new Map<
    string,
    { question: PendingMarketplaceQuestion; error: string; attempts: number }
  >();
  imported = new Map<string, MessageRow>();
  notifications = new Set<string>();
  draftClaims = 0;
  draftWrites = 0;
  failImport = false;

  async getCursor() {
    return this.cursor;
  }
  async markAttempt(at: Date) {
    this.attempts.push(at.toISOString());
  }
  async markSuccess(cursor: Date, pendingResolutionCount = 0) {
    this.cursor = cursor;
    this.successes.push(cursor.toISOString());
    this.pendingResolutionCounts.push(pendingResolutionCount);
  }
  async markFailure(_at: Date, error: unknown) {
    this.failures.push(error instanceof Error ? error.message : "failed");
  }
  async findActiveListing(externalListingId: string) {
    return externalListingId === question.externalListingId ? listing : null;
  }
  async listPendingQuestions() {
    return [...this.pending.values()].map(({ question }) => question);
  }
  async upsertPendingQuestion(
    failure: MarketplaceQuestionResolutionFailure,
  ) {
    const existing = this.pending.get(failure.question.externalMessageId);
    this.pending.set(failure.question.externalMessageId, {
      question: existing?.question ?? failure.question,
      error: failure.error,
      attempts: (existing?.attempts ?? 0) + 1,
    });
  }
  async markPendingResolutionFailed(
    externalMessageId: string,
    _at: Date,
    error: unknown,
  ) {
    const pending = this.pending.get(externalMessageId);
    if (!pending) return;
    pending.error = error instanceof Error ? error.message : "failed";
    pending.attempts += 1;
  }
  async removePendingQuestion(externalMessageId: string) {
    this.pending.delete(externalMessageId);
  }
  async countPendingQuestions() {
    return this.pending.size;
  }
  async importQuestion(
    external: MarketplaceQuestion,
    context: SyncListingContext,
  ): Promise<ImportedQuestionResult> {
    if (this.failImport) throw new Error("database unavailable");
    const existing = this.imported.get(external.externalMessageId);
    if (existing) return { message: existing, inserted: false };
    const row: MessageRow = {
      id: MESSAGE_ID,
      user_id: USER_ID,
      item_id: context.itemId,
      listing_id: context.listingId,
      direction: "inbound",
      body: external.body,
      draft_reply: null,
      status: "new",
      sent_at: null,
      reply_to: null,
      reply_kind: null,
      draft_model: null,
      created_at: external.createdAt,
      updated_at: external.createdAt,
      marketplace: external.marketplace,
      external_message_id: external.externalMessageId,
      external_parent_id: external.externalParentId,
      external_conversation_id: external.externalConversationId,
      external_listing_id: external.externalListingId,
      external_buyer_id: external.externalBuyerId,
      external_created_at: external.createdAt,
      delivery_request_id: null,
      delivery_status: null,
      external_delivery_id: null,
      delivery_attempted_at: null,
      delivery_error: null,
    };
    this.imported.set(external.externalMessageId, row);
    return { message: row, inserted: true };
  }
  async ensureNotification(
    _external: MarketplaceQuestion,
    _context: SyncListingContext,
    message: MessageRow,
  ) {
    this.notifications.add(message.id);
  }
  async listDraftCandidates(): Promise<DraftCandidate[]> {
    return [...this.imported.values()]
      .filter((message) =>
        ["new", "draft_failed", "drafting"].includes(message.status),
      )
      .map((message) => ({ message, grounding }));
  }
  async claimDraft(candidate: DraftCandidate) {
    const current = this.imported.get(candidate.message.external_message_id!);
    if (!current || !["new", "draft_failed"].includes(current.status)) return false;
    current.status = "drafting";
    this.draftClaims += 1;
    return true;
  }
  async attachDraft(messageId: string) {
    const message = [...this.imported.values()].find((row) => row.id === messageId)!;
    message.status = "drafted";
    message.draft_reply = "Yes, the charger is included.";
    this.draftWrites += 1;
  }
  async markDraftFailed(messageId: string) {
    const message = [...this.imported.values()].find((row) => row.id === messageId)!;
    message.status = "draft_failed";
  }
}

describe("syncInboxForSeller", () => {
  it("durably queues unresolved questions while importing valid peers", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const unresolvedQuestion: PendingMarketplaceQuestion = {
      marketplace: "ebay",
      externalMessageId: "ebay-question-unresolved",
      externalParentId: "ebay-question-unresolved",
      externalListingId: "110011001101",
      externalBuyerId: "buyer-unresolved",
      body: "Is the case included?",
      subject: null,
      createdAt: "2026-07-13T12:03:00.000Z",
      resolutionWindowFrom: "2026-07-12T12:05:00.000Z",
      observedCursorAt: "2026-07-13T12:05:00.000Z",
    };
    adapter.questions = [question];
    adapter.unresolved = [
      {
        question: unresolvedQuestion,
        error: "Commerce conversation lookup unavailable",
      },
    ];
    const repository = new MemorySyncRepository();

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      draft: async () => ({
        reply: "Yes, the charger is included.",
        model: "test-reply",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
    });

    expect(summary).toMatchObject({
      fetched: 2,
      imported: 1,
      pendingResolution: 1,
    });
    expect(repository.cursor?.toISOString()).toBe("2026-07-13T12:05:00.000Z");
    expect(repository.pending.get(unresolvedQuestion.externalMessageId)).toEqual({
      question: unresolvedQuestion,
      error: "Commerce conversation lookup unavailable",
      attempts: 1,
    });
    expect(repository.pendingResolutionCounts).toEqual([1]);
  });

  it("retries a durable unresolved question after it leaves the fetch window", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();
    repository.cursor = new Date("2026-07-15T12:00:00.000Z");
    repository.pending.set(question.externalMessageId, {
      question: {
        marketplace: "ebay",
        externalMessageId: question.externalMessageId,
        externalParentId: question.externalParentId,
        externalListingId: question.externalListingId,
        externalBuyerId: question.externalBuyerId,
        body: question.body,
        subject: question.subject,
        createdAt: question.createdAt,
        resolutionWindowFrom: "2026-07-12T12:05:00.000Z",
        observedCursorAt: "2026-07-13T12:05:00.000Z",
      },
      error: "Commerce conversation lookup unavailable",
      attempts: 3,
    });

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-15T12:05:00.000Z"),
      draft: async () => ({
        reply: "Yes, the charger is included.",
        model: "test-reply",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
    });

    expect(summary).toMatchObject({
      fetched: 0,
      imported: 1,
      drafted: 1,
      pendingResolution: 0,
    });
    expect(repository.pending).toHaveLength(0);
    expect(repository.notifications).toEqual(new Set([MESSAGE_ID]));
    expect(repository.pendingResolutionCounts).toEqual([0]);
  });

  it("retires a pending question absent from a complete unanswered window", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();
    const answeredElsewhere: PendingMarketplaceQuestion = {
      marketplace: "ebay",
      externalMessageId: "ebay-question-answered-elsewhere",
      externalParentId: "ebay-question-answered-elsewhere",
      externalListingId: question.externalListingId,
      externalBuyerId: "buyer-answered-elsewhere",
      body: "Can you ship tomorrow?",
      subject: null,
      createdAt: "2026-07-13T12:03:00.000Z",
      resolutionWindowFrom: "2026-07-12T12:05:00.000Z",
      observedCursorAt: "2026-07-13T12:05:00.000Z",
    };
    repository.pending.set(answeredElsewhere.externalMessageId, {
      question: answeredElsewhere,
      error: "Commerce lookup unavailable",
      attempts: 2,
    });

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      draft: async () => ({
        reply: "Yes, the charger is included.",
        model: "test-reply",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
    });

    expect(summary).toMatchObject({
      fetched: 1,
      imported: 1,
      drafted: 1,
      pendingResolution: 0,
    });
    expect(repository.pending.has(answeredElsewhere.externalMessageId)).toBe(
      false,
    );
    expect(repository.imported.has(answeredElsewhere.externalMessageId)).toBe(
      false,
    );
    expect(repository.imported.has(question.externalMessageId)).toBe(true);
    expect(repository.notifications).toEqual(new Set([MESSAGE_ID]));
  });

  it("keeps persistent resolution failures queued and visible after cursor advancement", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    const pendingQuestion: PendingMarketplaceQuestion = {
      marketplace: "ebay",
      externalMessageId: "ebay-question-persistent",
      externalParentId: "ebay-question-persistent",
      externalListingId: question.externalListingId,
      externalBuyerId: "buyer-persistent",
      body: "Can you ship tomorrow?",
      subject: null,
      createdAt: "2026-07-11T12:03:00.000Z",
      resolutionWindowFrom: "2026-07-10T12:05:00.000Z",
      observedCursorAt: "2026-07-11T12:05:00.000Z",
    };
    repository.cursor = new Date("2026-07-15T12:00:00.000Z");
    repository.pending.set(pendingQuestion.externalMessageId, {
      question: pendingQuestion,
      error: "Commerce lookup unavailable",
      attempts: 3,
    });
    adapter.resolutionFailures.set(
      pendingQuestion.externalMessageId,
      new Error("Commerce authorization unavailable"),
    );

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-15T12:05:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(summary).toMatchObject({
      fetched: 0,
      imported: 0,
      pendingResolution: 1,
    });
    expect(repository.pending.get(pendingQuestion.externalMessageId)).toEqual({
      question: pendingQuestion,
      error: "Commerce authorization unavailable",
      attempts: 4,
    });
    expect(repository.cursor?.toISOString()).toBe("2026-07-15T12:05:00.000Z");
    expect(repository.pendingResolutionCounts).toEqual([1]);
  });

  it("reconciles at least 24 hours behind the cursor on every sync", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    repository.cursor = new Date("2026-07-13T12:00:00.000Z");
    const previous = process.env.EBAY_MESSAGE_SYNC_OVERLAP_MINUTES;
    process.env.EBAY_MESSAGE_SYNC_OVERLAP_MINUTES = "10";

    try {
      await syncInboxForSeller({
        adapter,
        repository,
        now: () => new Date("2026-07-13T12:05:00.000Z"),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.EBAY_MESSAGE_SYNC_OVERLAP_MINUTES;
      } else {
        process.env.EBAY_MESSAGE_SYNC_OVERLAP_MINUTES = previous;
      }
    }

    expect(adapter.fetches[0]?.from.toISOString()).toBe(
      "2026-07-12T12:00:00.000Z",
    );
  });

  it("imports, notifies, and drafts one active-listing question exactly once across overlap replay", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();
    const draft = vi.fn(async () => ({
      reply: "Yes, the charger is included.",
      model: "test-reply",
      usedFallback: false,
    }));
    const meterDraft = vi.fn(async () => undefined);
    let now = new Date("2026-07-13T12:05:00.000Z");

    const first = await syncInboxForSeller({
      adapter,
      repository,
      now: () => now,
      initialLookbackMs: 10 * 60_000,
      overlapMs: 10 * 60_000,
      draft,
      meterDraft,
    });
    now = new Date("2026-07-13T12:10:00.000Z");
    const second = await syncInboxForSeller({
      adapter,
      repository,
      now: () => now,
      initialLookbackMs: 10 * 60_000,
      overlapMs: 10 * 60_000,
      draft,
      meterDraft,
    });

    expect(first).toMatchObject({ fetched: 1, imported: 1, drafted: 1 });
    expect(second).toMatchObject({ fetched: 1, imported: 0, drafted: 0 });
    expect(repository.imported).toHaveLength(1);
    expect(repository.notifications).toEqual(new Set([MESSAGE_ID]));
    expect(repository.draftClaims).toBe(1);
    expect(repository.draftWrites).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(meterDraft).toHaveBeenCalledTimes(1);
    expect(adapter.fetches[1]?.from.toISOString()).toBe(
      "2026-07-12T12:05:00.000Z",
    );
    expect(repository.imported.get(question.externalMessageId)?.user_id).toBe(
      USER_ID,
    );
    expect(
      repository.imported.get(question.externalMessageId)
        ?.external_conversation_id,
    ).toBe("commerce-conversation-9");
  });

  it("does not advance the cursor when durable import fails", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();
    repository.failImport = true;

    await expect(
      syncInboxForSeller({
        adapter,
        repository,
        now: () => new Date("2026-07-13T12:05:00.000Z"),
        initialLookbackMs: 10 * 60_000,
      }),
    ).rejects.toThrow("database unavailable");
    expect(repository.cursor).toBeNull();
    expect(repository.successes).toHaveLength(0);
    expect(repository.failures).toEqual(["database unavailable"]);
  });

  it("skips questions that cannot map to this tenant's active listing", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [{ ...question, externalListingId: "foreign-listing" }];
    const repository = new MemorySyncRepository();

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
    });
    expect(summary).toMatchObject({
      fetched: 1,
      imported: 0,
      skippedUnknownListing: 1,
      drafted: 0,
    });
    expect(repository.imported).toHaveLength(0);
  });
});

describe("SupabaseInboxSyncRepository", () => {
  it("uses the tenant-derived RPC for foreground lifecycle mutations", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: false,
    });

    await repository.markAttempt(new Date("2026-07-13T12:05:00.000Z"));

    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "sync_mark_attempt",
      p_payload: { at: "2026-07-13T12:05:00.000Z" },
    });
  });

  it("uses the separate scheduler RPC for background lifecycle mutations", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: true,
    });

    await repository.markAttempt(new Date("2026-07-13T12:05:00.000Z"));

    expect(rpc).toHaveBeenCalledWith("apply_scheduled_ebay_message_write", {
      p_user_id: USER_ID,
      p_operation: "sync_mark_attempt",
      p_payload: { at: "2026-07-13T12:05:00.000Z" },
    });
  });

  it("writes unresolved identity through the tenant-derived foreground seam", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: false,
    });
    const pendingQuestion: PendingMarketplaceQuestion = {
      marketplace: "ebay",
      externalMessageId: "question-pending",
      externalParentId: "question-pending",
      externalListingId: "listing-pending",
      externalBuyerId: "buyer-pending",
      body: "Is the case included?",
      subject: null,
      createdAt: "2026-07-13T12:01:00.000Z",
      resolutionWindowFrom: "2026-07-12T12:05:00.000Z",
      observedCursorAt: "2026-07-13T12:05:00.000Z",
    };

    await repository.upsertPendingQuestion(
      { question: pendingQuestion, error: "Commerce lookup unavailable" },
      new Date("2026-07-13T12:05:00.000Z"),
    );

    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "upsert_unresolved_question",
      p_payload: {
        external_message_id: "question-pending",
        external_parent_id: "question-pending",
        external_listing_id: "listing-pending",
        external_buyer_id: "buyer-pending",
        body: "Is the case included?",
        subject: null,
        external_created_at: "2026-07-13T12:01:00.000Z",
        resolution_window_from: "2026-07-12T12:05:00.000Z",
        observed_cursor_at: "2026-07-13T12:05:00.000Z",
        attempted_at: "2026-07-13T12:05:00.000Z",
        error: "Commerce lookup unavailable",
      },
    });
  });
});
