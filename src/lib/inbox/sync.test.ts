import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { MockMarketplaceMessagingAdapter } from "@/lib/marketplace/mock-messaging";
import type {
  MarketplaceQuestion,
  MarketplaceQuestionResolutionFailure,
  PendingMarketplaceQuestion,
} from "@/lib/marketplace/messaging";
import type { MessageRow, ReplyGrounding } from "./types";
import type {
  AuthoritativeMessageGrounding,
  MessagePolicyAuditRecord,
  MessagePolicyResult,
} from "./policy";
import type { MessagePolicyRepository } from "./autoreply";
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
  importedPhotos: Array<{ question: MarketplaceQuestion; messageId: string }> = [];
  draftClaims = 0;
  draftWrites = 0;
  failImport = false;
  deliveredCanonicalRoots = new Set<string>();

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
  async retirePendingQuestion(externalMessageId: string) {
    this.pending.delete(externalMessageId);
  }
  async countPendingQuestions() {
    return this.pending.size;
  }
  async listActionableQuestions() {
    return [...this.imported.values()]
      .filter(
        (message) =>
          ["new", "drafting", "drafted", "draft_failed", "sent"].includes(
            message.status,
          ) &&
          !this.deliveredCanonicalRoots.has(message.id) &&
          Boolean(message.external_message_id) &&
          Boolean(message.external_created_at),
      )
      .map((message) => ({
        externalMessageId: message.external_message_id!,
        createdAt: message.external_created_at!,
      }));
  }
  async markExternallyAnswered(externalMessageId: string, at: Date) {
    const message = this.imported.get(externalMessageId);
    if (
      !message ||
      !["new", "drafting", "drafted", "draft_failed", "sent"].includes(
        message.status,
      ) ||
      this.deliveredCanonicalRoots.has(message.id)
    ) {
      return;
    }
    if (
      message.delivery_status === "sending" &&
      message.delivery_attempted_at &&
      Date.parse(message.delivery_attempted_at) >= at.getTime() - 5 * 60_000
    ) {
      return;
    }
    const preserveAttemptedReply = message.status === "sent";
    message.status = "externally_answered";
    if (!preserveAttemptedReply) {
      message.draft_reply = null;
      message.draft_model = null;
    }
  }
  async markProviderUnavailable(externalMessageId: string, at: Date) {
    const message = this.imported.get(externalMessageId);
    if (
      !message ||
      !["new", "drafting", "drafted", "draft_failed", "sent"].includes(
        message.status,
      ) ||
      this.deliveredCanonicalRoots.has(message.id)
    ) {
      return;
    }
    if (
      message.delivery_status === "sending" &&
      message.delivery_attempted_at &&
      Date.parse(message.delivery_attempted_at) >= at.getTime() - 5 * 60_000
    ) {
      return;
    }
    message.status = "provider_unavailable";
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
  async importQuestionPhotos(external: MarketplaceQuestion, message: MessageRow) {
    if (external.media?.length) {
      this.importedPhotos.push({ question: external, messageId: message.id });
    }
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

const authoritativeGrounding: AuthoritativeMessageGrounding = {
  listingId: LISTING_ID,
  active: true,
  current: true,
  conflicts: [],
  authorization: {
    listingUpdatedAt: "2026-07-13T12:00:00.000Z",
    itemUpdatedAt: "2026-07-13T12:00:00.000Z",
    marketplaceObservedAt: "2026-07-13T12:05:00.000Z",
    externalListingId: question.externalListingId,
  },
  facts: [
    {
      key: "availability",
      value: "active",
      source: "active_listing_state",
      reference: `listing:${LISTING_ID}:active-state`,
    },
  ],
};

class MemoryMessagePolicyRepository implements MessagePolicyRepository {
  enabled = true;
  decisions = new Map<string, MessagePolicyAuditRecord>();
  pending = new Set<string>();

  constructor(private readonly sync: MemorySyncRepository) {}

  async getEnabled() {
    return this.enabled;
  }

  async loadGrounding() {
    return authoritativeGrounding;
  }

  async recordDecision(
    message: MessageRow,
    result: MessagePolicyResult,
    draft: { reply: string; model: string },
  ) {
    const key = `${message.id}:${result.policyVersion}`;
    const existing = this.decisions.get(key);
    if (existing) return { inserted: false, decision: existing };
    const decision: MessagePolicyAuditRecord = {
      id: "55555555-5555-4555-8555-555555555555",
      messageId: message.id,
      ...result,
      draftReply: draft.reply,
      draftModel: draft.model,
      deliveryStatus: "not_attempted",
      decidedAt: "2026-07-13T12:05:00.000Z",
    };
    this.decisions.set(key, decision);
    message.status = "drafted";
    message.draft_reply = draft.reply;
    message.draft_model = draft.model;
    if (result.outcome === "auto_send") this.pending.add(message.id);
    return { inserted: true, decision };
  }

  async listPendingAutoSend() {
    return [...this.pending].map((messageId) => ({ messageId }));
  }

  async revalidatePendingAutoSend(messageId: string) {
    return this.enabled && this.pending.has(messageId)
      ? {
          authorized: true as const,
          marketplaceObservedAt:
            authoritativeGrounding.authorization.marketplaceObservedAt,
          questionObservedAt: "2026-07-13T12:05:00.000Z",
        }
      : { authorized: false as const, reason: "authorization_changed" as const };
  }

  async blockPendingAutoSend(messageId: string) {
    this.pending.delete(messageId);
  }

  markDelivered(messageId: string) {
    const message = [...this.sync.imported.values()].find(
      (candidate) => candidate.id === messageId,
    );
    if (message) {
      message.status = "sent";
      message.delivery_status = "delivered";
    }
    this.pending.delete(messageId);
  }
}

describe("syncInboxForSeller", () => {
  it("routes and auto-sends an eligible imported question once across overlapping syncs", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [{ ...question, body: "Is this still available?" }];
    const repository = new MemorySyncRepository();
    const policyRepository = new MemoryMessagePolicyRepository(repository);
    const send = vi.fn(async (messageId: string) => {
      policyRepository.markDelivered(messageId);
    });

    const first = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      policy: { repository: policyRepository, send },
    });
    const second = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:06:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      policy: { repository: policyRepository, send },
    });

    expect(first).toMatchObject({
      imported: 1,
      autoSent: 1,
      autoSendFailed: 0,
      policyDrafted: 0,
      policyEscalated: 0,
    });
    expect(second).toMatchObject({ imported: 0, autoSent: 0 });
    expect(policyRepository.decisions).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the default-disabled preference in seller approval with zero external sends", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [{ ...question, body: "Is this still available?" }];
    const repository = new MemorySyncRepository();
    const policyRepository = new MemoryMessagePolicyRepository(repository);
    policyRepository.enabled = false;
    const send = vi.fn();

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      draft: async () => ({
        reply: "Yes, it is available.",
        model: "reply-test",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
      policy: { repository: policyRepository, send },
    });

    expect(summary).toMatchObject({ policyDrafted: 1, autoSent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect([...policyRepository.decisions.values()][0]).toMatchObject({
      outcome: "draft_for_approval",
      reasonCodes: ["preference_disabled"],
    });
  });

  it("attempts an eligible answer in the same sync, within the five-minute scheduler contract", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [
      {
        ...question,
        body: "Is this still available?",
        createdAt: "2026-07-13T12:00:01.000Z",
      },
    ];
    const repository = new MemorySyncRepository();
    const policyRepository = new MemoryMessagePolicyRepository(repository);
    const send = vi.fn(async (messageId: string) => {
      policyRepository.markDelivered(messageId);
    });

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      policy: { repository: policyRepository, send },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(
      Date.parse("2026-07-13T12:05:00.000Z") -
        Date.parse("2026-07-13T12:00:01.000Z"),
    ).toBeLessThanOrEqual(5 * 60_000);
  });

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

  it("retires an old pending question absent from a covering unanswered window", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const currentPeer = {
      ...question,
      externalMessageId: "ebay-question-current-peer",
      externalParentId: "ebay-question-current-peer",
      createdAt: "2026-07-15T12:02:00.000Z",
    };
    adapter.questions = [currentPeer];
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
      fetched: 1,
      imported: 1,
      drafted: 1,
      pendingResolution: 0,
    });
    expect(repository.pending.has(question.externalMessageId)).toBe(false);
    expect(repository.imported.has(question.externalMessageId)).toBe(false);
    expect(repository.imported.has(currentPeer.externalMessageId)).toBe(true);
    expect(adapter.fetches).toEqual([
      {
        from: new Date("2026-07-14T12:00:00.000Z"),
        to: new Date("2026-07-15T12:05:00.000Z"),
      },
      {
        from: new Date(question.createdAt),
        to: new Date("2026-07-14T12:00:00.000Z"),
      },
    ]);
  });

  it("reconciles a pending question without a provider timestamp from its durable window", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    repository.cursor = new Date("2026-07-15T12:00:00.000Z");
    const pendingQuestion: PendingMarketplaceQuestion = {
      marketplace: "ebay",
      externalMessageId: "ebay-question-missing-created-at",
      externalParentId: "ebay-question-missing-created-at",
      externalListingId: question.externalListingId,
      externalBuyerId: null,
      body: null,
      subject: null,
      createdAt: null,
      resolutionWindowFrom: "2026-07-12T12:05:00.000Z",
      observedCursorAt: "2026-07-13T12:05:00.000Z",
    };
    repository.pending.set(pendingQuestion.externalMessageId, {
      question: pendingQuestion,
      error: "Required Trading fields were missing",
      attempts: 3,
    });

    const summary = await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-15T12:05:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(summary).toMatchObject({
      imported: 0,
      drafted: 0,
      pendingResolution: 0,
    });
    expect(repository.pending.has(pendingQuestion.externalMessageId)).toBe(false);
    expect(adapter.fetches).toEqual([
      {
        from: new Date("2026-07-14T12:00:00.000Z"),
        to: new Date("2026-07-15T12:05:00.000Z"),
      },
      {
        from: new Date(pendingQuestion.resolutionWindowFrom),
        to: new Date("2026-07-14T12:00:00.000Z"),
      },
    ]);
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
    adapter.unresolved = [
      {
        question: pendingQuestion,
        error: "Commerce authorization unavailable",
      },
    ];

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

  it("imports supported inbound media through the repository seam with zero network", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [{
      ...question,
      media: [{
        mediaName: "buyer-condition.jpg",
        mediaType: "IMAGE",
        mediaUrl: "https://i.ebayimg.com/images/g/test/s-l1600.jpg",
      }],
    }];
    const repository = new MemorySyncRepository();

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      initialLookbackMs: 10 * 60_000,
      draft: async () => ({ reply: "Thanks for the photo.", model: "test", usedFallback: false }),
    });

    expect(repository.importedPhotos).toEqual([{
      question: adapter.questions[0],
      messageId: MESSAGE_ID,
    }]);
    expect(adapter.fetches).toHaveLength(1);
  });

  it("marks an imported draft externally answered only with explicit provider evidence", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();
    const draft = vi.fn(async () => ({
      reply: "Yes, the charger is included.",
      model: "test-reply",
      usedFallback: false,
    }));

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      draft,
      meterDraft: async () => undefined,
    });
    adapter.questions = [];
    adapter.answeredExternalMessageIds = [question.externalMessageId];
    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:10:00.000Z"),
      draft,
      meterDraft: async () => undefined,
    });

    expect(repository.imported.get(question.externalMessageId)).toMatchObject({
      status: "externally_answered",
      draft_reply: null,
      draft_model: null,
    });
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("uses a neutral non-actionable state when an imported question disappears without answer evidence", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      draft: async () => ({
        reply: "Yes, the charger is included.",
        model: "test-reply",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
    });
    const imported = repository.imported.get(question.externalMessageId)!;
    imported.status = "sent";
    imported.delivery_status = "ambiguous";
    imported.delivery_attempted_at = "2026-07-13T12:06:00.000Z";

    adapter.questions = [];
    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:12:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(question.externalMessageId)).toMatchObject({
      status: "provider_unavailable",
      draft_reply: "Yes, the charger is included.",
      delivery_status: "ambiguous",
      delivery_attempted_at: "2026-07-13T12:06:00.000Z",
    });
  });

  it("neutralizes an unacknowledged send claim when eBay no longer reports the question", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.questions = [question];
    const repository = new MemorySyncRepository();

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:05:00.000Z"),
      draft: async () => ({
        reply: "Yes, the charger is included.",
        model: "test-reply",
        usedFallback: false,
      }),
      meterDraft: async () => undefined,
    });
    const imported = repository.imported.get(question.externalMessageId)!;
    imported.status = "sent";
    imported.delivery_status = "ambiguous";
    imported.delivery_attempted_at = "2026-07-13T12:06:00.000Z";

    adapter.questions = [];
    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:10:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(question.externalMessageId)).toMatchObject({
      status: "provider_unavailable",
      delivery_status: "ambiguous",
      delivery_attempted_at: "2026-07-13T12:06:00.000Z",
    });
  });

  it("does not retire a fresh active delivery lease", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    const imported = await repository.importQuestion(question, listing);
    imported.message.status = "sent";
    imported.message.draft_reply = "Yes, the charger is included.";
    imported.message.delivery_status = "sending";
    imported.message.delivery_attempted_at = "2026-07-13T12:06:00.000Z";

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:10:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(question.externalMessageId)).toMatchObject({
      status: "sent",
      draft_reply: "Yes, the charger is included.",
      delivery_status: "sending",
      delivery_attempted_at: "2026-07-13T12:06:00.000Z",
    });
  });

  it("reconciles actionable questions older than the ingestion lookback", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    repository.cursor = new Date("2026-07-15T12:00:00.000Z");
    const oldQuestion = {
      ...question,
      externalMessageId: "ebay-question-old-draft",
      externalParentId: "ebay-question-old-draft",
      createdAt: "2026-07-11T12:04:00.000Z",
    };
    const imported = await repository.importQuestion(oldQuestion, listing);
    imported.message.status = "drafted";
    imported.message.draft_reply = "Yes, the charger is included.";

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-15T12:05:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(oldQuestion.externalMessageId)).toMatchObject({
      status: "provider_unavailable",
      draft_reply: "Yes, the charger is included.",
    });
    expect(adapter.fetches).toEqual([
      {
        from: new Date("2026-07-14T12:00:00.000Z"),
        to: new Date("2026-07-15T12:05:00.000Z"),
      },
      {
        from: new Date("2026-07-11T12:04:00.000Z"),
        to: new Date("2026-07-14T12:00:00.000Z"),
      },
    ]);
  });

  it("keeps an older unanswered question actionable without importing unrelated history", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    repository.cursor = new Date("2026-07-15T12:00:00.000Z");
    const oldQuestion = {
      ...question,
      externalMessageId: "ebay-question-old-unanswered",
      externalParentId: "ebay-question-old-unanswered",
      createdAt: "2026-07-11T12:04:00.000Z",
    };
    const unrelatedOldQuestion = {
      ...question,
      externalMessageId: "ebay-question-unrelated-history",
      externalParentId: "ebay-question-unrelated-history",
      createdAt: "2026-07-12T12:04:00.000Z",
    };
    const imported = await repository.importQuestion(oldQuestion, listing);
    imported.message.status = "drafted";
    imported.message.draft_reply = "Yes, the charger is included.";
    adapter.questions = [oldQuestion, unrelatedOldQuestion];

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-15T12:05:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(oldQuestion.externalMessageId)).toMatchObject({
      status: "drafted",
      draft_reply: "Yes, the charger is included.",
    });
    expect(repository.imported.has(unrelatedOldQuestion.externalMessageId)).toBe(
      false,
    );
    expect(adapter.fetches).toHaveLength(2);
  });

  it("does not retire a question with a delivered canonical acknowledgement", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    const imported = await repository.importQuestion(question, listing);
    imported.message.status = "sent";
    imported.message.delivery_status = "delivered";
    imported.message.external_delivery_id = "ebay-acknowledgement-42";
    repository.deliveredCanonicalRoots.add(imported.message.id);

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:10:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(question.externalMessageId)).toMatchObject({
      status: "sent",
      delivery_status: "delivered",
      external_delivery_id: "ebay-acknowledgement-42",
    });
  });

  it("does not retire a question whose provider timestamp is beyond the sync cutoff", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemorySyncRepository();
    const futureQuestion = {
      ...question,
      externalMessageId: "ebay-question-future-clock",
      externalParentId: "ebay-question-future-clock",
      createdAt: "2026-07-13T12:11:00.000Z",
    };
    const imported = await repository.importQuestion(futureQuestion, listing);
    imported.message.status = "drafted";
    imported.message.draft_reply = "Yes, the charger is included.";

    await syncInboxForSeller({
      adapter,
      repository,
      now: () => new Date("2026-07-13T12:10:00.000Z"),
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });

    expect(repository.imported.get(futureQuestion.externalMessageId)).toMatchObject({
      status: "drafted",
      draft_reply: "Yes, the charger is included.",
    });
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
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "begin_ebay_message_write"
          ? "11111111-1111-4111-8111-111111111111"
          : null,
      error: null,
    }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: false,
    });

    await repository.markAttempt(new Date("2026-07-13T12:05:00.000Z"));

    expect(rpc).toHaveBeenCalledWith("begin_ebay_message_write");
    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "sync_mark_attempt",
      p_payload: { at: "2026-07-13T12:05:00.000Z" },
      p_generation: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("uses the separate scheduler RPC for background lifecycle mutations", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "begin_scheduled_ebay_message_write"
          ? "22222222-2222-4222-8222-222222222222"
          : null,
      error: null,
    }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: true,
    });

    await repository.markAttempt(new Date("2026-07-13T12:05:00.000Z"));

    expect(rpc).toHaveBeenCalledWith("begin_scheduled_ebay_message_write", {
      p_user_id: USER_ID,
    });
    expect(rpc).toHaveBeenCalledWith("apply_scheduled_ebay_message_write", {
      p_user_id: USER_ID,
      p_operation: "sync_mark_attempt",
      p_payload: { at: "2026-07-13T12:05:00.000Z" },
      p_generation: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("uses scheduler read RPCs instead of service-role table reads", async () => {
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "begin_scheduled_ebay_message_write") {
        return {
          data: "22222222-2222-4222-8222-222222222222",
          error: null,
        };
      }
      if (
        name === "read_scheduled_ebay_inbox" &&
        args?.p_operation === "cursor"
      ) {
        return {
          data: { cursor_at: "2026-07-13T12:00:00.000Z" },
          error: null,
        };
      }
      if (
        name === "read_scheduled_ebay_inbox" &&
        args?.p_operation === "pending_questions"
      ) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });
    const from = vi.fn(() => {
      throw new Error("scheduled reads must not access tables directly");
    });
    const client = { rpc, from } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: true,
    });

    await expect(repository.getCursor()).resolves.toEqual(
      new Date("2026-07-13T12:00:00.000Z"),
    );
    await expect(repository.listPendingQuestions()).resolves.toEqual([]);

    expect(from).not.toHaveBeenCalled();
    expect(rpc.mock.calls.slice(0, 2).map(([name]) => name)).toEqual([
      "begin_scheduled_ebay_message_write",
      "read_scheduled_ebay_inbox",
    ]);
    expect(rpc).toHaveBeenCalledWith("read_scheduled_ebay_inbox", {
      p_user_id: USER_ID,
      p_operation: "cursor",
      p_payload: {},
    });
    expect(rpc).toHaveBeenCalledWith("read_scheduled_ebay_inbox", {
      p_user_id: USER_ID,
      p_operation: "pending_questions",
      p_payload: {},
    });
  });

  it("pins every write in one sync repository to one account generation", async () => {
    const generation = "33333333-3333-4333-8333-333333333333";
    const rpc = vi.fn(async (name: string) => ({
      data: name === "begin_ebay_message_write" ? generation : null,
      error: null,
    }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: false,
    });

    await repository.markAttempt(new Date("2026-07-13T12:05:00.000Z"));
    await repository.markSuccess(
      new Date("2026-07-13T12:06:00.000Z"),
      0,
    );

    expect(rpc.mock.calls.filter(([name]) => name === "begin_ebay_message_write"))
      .toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "sync_mark_success",
      p_payload: {
        at: "2026-07-13T12:06:00.000Z",
        pending_resolution_count: 0,
      },
      p_generation: generation,
    });
  });

  it("writes unresolved identity through the tenant-derived foreground seam", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "begin_ebay_message_write"
          ? "11111111-1111-4111-8111-111111111111"
          : null,
      error: null,
    }));
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
      externalBuyerUsername: "buyer_pending_legacy",
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
        external_buyer_username: "buyer_pending_legacy",
        body: "Is the case included?",
        subject: null,
        external_created_at: "2026-07-13T12:01:00.000Z",
        resolution_window_from: "2026-07-12T12:05:00.000Z",
        observed_cursor_at: "2026-07-13T12:05:00.000Z",
        attempted_at: "2026-07-13T12:05:00.000Z",
        error: "Commerce lookup unavailable",
      },
      p_generation: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("passes the reconciliation time through the tenant write seam", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "begin_ebay_message_write"
          ? "11111111-1111-4111-8111-111111111111"
          : null,
      error: null,
    }));
    const client = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseInboxSyncRepository(client, USER_ID, {
      client,
      scheduled: false,
    });

    await repository.markExternallyAnswered(
      "question-pending",
      new Date("2026-07-13T12:05:00.000Z"),
    );

    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "mark_externally_answered",
      p_payload: {
        external_message_id: "question-pending",
        at: "2026-07-13T12:05:00.000Z",
      },
      p_generation: "11111111-1111-4111-8111-111111111111",
    });
  });
});
