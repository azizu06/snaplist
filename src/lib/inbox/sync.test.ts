import { describe, expect, it, vi } from "vitest";
import { MockMarketplaceMessagingAdapter } from "@/lib/marketplace/mock-messaging";
import type { MarketplaceQuestion } from "@/lib/marketplace/messaging";
import type { MessageRow, ReplyGrounding } from "./types";
import {
  syncInboxForSeller,
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
  async markSuccess(cursor: Date) {
    this.cursor = cursor;
    this.successes.push(cursor.toISOString());
  }
  async markFailure(_at: Date, error: unknown) {
    this.failures.push(error instanceof Error ? error.message : "failed");
  }
  async findActiveListing(externalListingId: string) {
    return externalListingId === question.externalListingId ? listing : null;
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
      "2026-07-13T11:55:00.000Z",
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
