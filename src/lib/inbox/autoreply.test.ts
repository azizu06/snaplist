import { describe, expect, it, vi } from "vitest";
import type { DraftBuyerReplyResult } from "./reply";
import type { MessageRow, ReplyGrounding } from "./types";
import {
  processMessagePolicyCandidate,
  sendPendingAutomaticReplies,
  type MessagePolicyRepository,
} from "./autoreply";
import type {
  AuthoritativeMessageGrounding,
  MessagePolicyAuditRecord,
  MessagePolicyResult,
} from "./policy";

const message: MessageRow = {
  id: "33333333-3333-4333-8333-333333333333",
  user_id: "user_a",
  item_id: "11111111-1111-4111-8111-111111111111",
  listing_id: "22222222-2222-4222-8222-222222222222",
  direction: "inbound",
  body: "Is this still available?",
  draft_reply: null,
  status: "drafting",
  sent_at: null,
  reply_to: null,
  draft_model: null,
  created_at: "2026-07-14T12:00:00.000Z",
  updated_at: "2026-07-14T12:00:00.000Z",
  marketplace: "ebay",
  external_message_id: "question-1",
  external_parent_id: "question-1",
  external_conversation_id: "conversation-1",
  external_listing_id: "listing-1",
  external_buyer_id: "buyer-1",
  external_created_at: "2026-07-14T12:00:00.000Z",
  delivery_request_id: null,
  delivery_status: null,
  external_delivery_id: null,
  delivery_attempted_at: null,
  delivery_error: null,
  ebay_account_generation: "44444444-4444-4444-8444-444444444444",
};

const draftGrounding: ReplyGrounding = {
  attributes: { brand: "Sony", model: "WH-1000XM5" },
  listing: { title: "Sony WH-1000XM5", description: "Used headphones." },
};

const policyGrounding: AuthoritativeMessageGrounding = {
  listingId: message.listing_id!,
  active: true,
  current: true,
  conflicts: [],
  authorization: {
    listingUpdatedAt: "2026-07-14T12:00:00.000Z",
    itemUpdatedAt: "2026-07-14T12:00:00.000Z",
    marketplaceObservedAt: "2026-07-14T12:01:00.000Z",
    externalListingId: "listing-1",
  },
  facts: [
    {
      key: "availability",
      value: "active",
      source: "active_listing_state",
      reference: `listing:${message.listing_id}:active-state`,
    },
  ],
};

class MemoryPolicyRepository implements MessagePolicyRepository {
  enabled = true;
  decisions = new Map<string, MessagePolicyAuditRecord>();
  pending = new Set<string>();
  blocked = new Map<string, string>();
  marketplaceCurrent = true;
  questionUnanswered = true;
  revalidationFailure = false;

  async getEnabled() {
    return this.enabled;
  }

  async loadGrounding() {
    return policyGrounding;
  }

  async recordDecision(
    candidate: MessageRow,
    result: MessagePolicyResult,
    draft: DraftBuyerReplyResult,
  ) {
    const key = `${candidate.id}:${result.policyVersion}`;
    const existing = this.decisions.get(key);
    if (existing) return { inserted: false, decision: existing };
    const decision: MessagePolicyAuditRecord = {
      id: "55555555-5555-4555-8555-555555555555",
      messageId: candidate.id,
      ...result,
      draftReply: draft.reply,
      draftModel: draft.model,
      deliveryStatus: "not_attempted",
      decidedAt: "2026-07-14T12:01:00.000Z",
    };
    this.decisions.set(key, decision);
    if (result.outcome === "auto_send") this.pending.add(candidate.id);
    return { inserted: true, decision };
  }

  async listPendingAutoSend() {
    return [...this.pending].map((messageId) => ({ messageId }));
  }

  async revalidatePendingAutoSend(messageId: string) {
    if (this.revalidationFailure) throw new Error("eBay unavailable");
    if (!this.questionUnanswered) {
      return { authorized: false as const, reason: "question_not_unanswered" as const };
    }
    return this.enabled && this.marketplaceCurrent && this.pending.has(messageId)
      ? {
          authorized: true as const,
          marketplaceObservedAt: policyGrounding.authorization.marketplaceObservedAt,
          questionObservedAt: "2026-07-14T12:01:30.000Z",
        }
      : { authorized: false as const, reason: "authorization_changed" as const };
  }

  async blockPendingAutoSend(messageId: string, reason: string) {
    this.pending.delete(messageId);
    this.blocked.set(messageId, reason);
  }
}

describe("message policy orchestration", () => {
  it("records and sends one deterministic automatic reply without invoking the model", async () => {
    const repository = new MemoryPolicyRepository();
    const draft = vi.fn();
    const meterDraft = vi.fn();

    const recorded = await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft,
      meterDraft,
    });

    expect(recorded.decision.outcome).toBe("auto_send");
    expect(recorded.decision.draftReply).toBe(
      "Yes — this listing is currently active on eBay.",
    );
    expect(draft).not.toHaveBeenCalled();
    expect(meterDraft).not.toHaveBeenCalled();

    const send = vi.fn(async (messageId: string) => {
      repository.pending.delete(messageId);
    });
    await sendPendingAutomaticReplies({ repository, send });
    await sendPendingAutomaticReplies({ repository, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(message.id, {
      marketplaceObservedAt: policyGrounding.authorization.marketplaceObservedAt,
      questionObservedAt: "2026-07-14T12:01:30.000Z",
    });
  });

  it("generates a seller-reviewable draft for negotiation and never auto-sends it", async () => {
    const repository = new MemoryPolicyRepository();
    const draft = vi.fn(async (): Promise<DraftBuyerReplyResult> => ({
      reply: "Thanks for the offer. I will review it.",
      model: "reply-test",
      usedFallback: false,
    }));
    const meterDraft = vi.fn(async () => undefined);
    const send = vi.fn();

    const recorded = await processMessagePolicyCandidate({
      repository,
      candidate: {
        message: { ...message, body: "Would you take $150?" },
        grounding: draftGrounding,
      },
      draft,
      meterDraft,
    });
    await sendPendingAutomaticReplies({ repository, send });

    expect(recorded.decision.outcome).toBe("draft_for_approval");
    expect(draft).toHaveBeenCalledOnce();
    expect(meterDraft).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("persists one audit result per policy version when duplicate workers race", async () => {
    const repository = new MemoryPolicyRepository();
    const input = {
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    };

    const [first, second] = await Promise.all([
      processMessagePolicyCandidate(input),
      processMessagePolicyCandidate(input),
    ]);

    expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
    expect(repository.decisions).toHaveLength(1);
  });

  it("leaves failed or ambiguous external delivery truthful and retryable", async () => {
    const repository = new MemoryPolicyRepository();
    await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });
    const send = vi.fn(async () => {
      throw new Error("delivery ambiguous");
    });

    const summary = await sendPendingAutomaticReplies({ repository, send });

    expect(summary).toEqual({ sent: 0, failed: 1 });
    expect(repository.pending).toEqual(new Set([message.id]));
  });

  it("honors a seller disabling the preference before a queued send", async () => {
    const repository = new MemoryPolicyRepository();
    await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });
    repository.enabled = false;
    const send = vi.fn();

    expect(await sendPendingAutomaticReplies({ repository, send })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(repository.blocked.get(message.id)).toBe("authorization_changed");
  });

  it("does not send after marketplace facts change", async () => {
    const repository = new MemoryPolicyRepository();
    await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });
    repository.marketplaceCurrent = false;
    const send = vi.fn();

    expect(await sendPendingAutomaticReplies({ repository, send })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(repository.blocked.get(message.id)).toBe("authorization_changed");
  });

  it("blocks a queued reply when eBay reports the question answered", async () => {
    const repository = new MemoryPolicyRepository();
    await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });
    repository.questionUnanswered = false;
    const send = vi.fn();

    expect(await sendPendingAutomaticReplies({ repository, send })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(repository.blocked.get(message.id)).toBe("question_not_unanswered");
  });

  it("terminally blocks automatic delivery when revalidation fails", async () => {
    const repository = new MemoryPolicyRepository();
    await processMessagePolicyCandidate({
      repository,
      candidate: { message, grounding: draftGrounding },
      draft: vi.fn(),
      meterDraft: vi.fn(),
    });
    repository.revalidationFailure = true;

    expect(
      await sendPendingAutomaticReplies({ repository, send: vi.fn() }),
    ).toEqual({ sent: 0, failed: 1 });
    expect(repository.blocked.get(message.id)).toBe("revalidation_failed");
  });
});
