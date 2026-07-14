import { describe, expect, it, vi } from "vitest";
import { MockMarketplaceMessagingAdapter } from "@/lib/marketplace/mock-messaging";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import type { MessageAttachmentRow, MessageRow } from "./types";
import {
  MessageDeliveryAttemptError,
  MessageDeliveryConflictError,
  sendCanonicalReply,
  sendSellerFollowUp,
  retryFollowUpDelivery,
  type DeliveryRepository,
} from "./transport";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ROOT_ID,
    user_id: "user_a",
    item_id: ITEM_ID,
    listing_id: LISTING_ID,
    direction: "inbound",
    body: "Does it include the charger?",
    draft_reply: "Yes, it includes the original charger.",
    status: "drafted",
    sent_at: null,
    reply_to: null,
    reply_kind: null,
    draft_model: "test",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
    marketplace: "ebay",
    external_message_id: "mail-display-id-never-use",
    external_parent_id: "exact-question-parent-42",
    external_conversation_id: "commerce-conversation-9",
    external_listing_id: "110011001100",
    external_buyer_id: "buyer-public-id",
    external_created_at: "2026-07-13T12:00:00.000Z",
    delivery_request_id: null,
    delivery_status: null,
    external_delivery_id: null,
    delivery_attempted_at: null,
    delivery_error: null,
    ebay_account_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

class MemoryDeliveryRepository implements DeliveryRepository {
  root = message();
  dispatchGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  dispatches: Array<{ id: string; attemptedAt: string }> = [];
  dispatchRenewals: Array<{ id: string; attemptedAt: string }> = [];
  dispatchRenewalFailure?: Error;
  canonical: MessageRow | null = null;
  followUps = new Map<string, MessageRow>();
  followUpsByRequest = new Map<string, MessageRow>();
  failures: Array<{ id: string; kind: string }> = [];
  sequence = 0;

  async loadConversationRoot(id: string) {
    return id === this.root.id ? this.root : null;
  }
  async canonicalDelivered(root: MessageRow) {
    return root.id === this.root.id ? this.canonical : null;
  }
  async claimCanonical(_root: MessageRow, body: string, at: Date, retry: boolean) {
    if (!retry && this.root.status !== "drafted") return false;
    const staleSending =
      this.root.delivery_status === "sending" &&
      typeof this.root.delivery_attempted_at === "string" &&
      Date.parse(this.root.delivery_attempted_at) < at.getTime() - 5 * 60_000;
    if (
      retry &&
      !staleSending &&
      !["rejected", "failed", "ambiguous"].includes(this.root.delivery_status ?? "")
    ) {
      return false;
    }
    this.root.status = "sent";
    this.root.draft_reply = body;
    this.root.delivery_request_id = this.root.id;
    this.root.delivery_status = "sending";
    this.root.delivery_attempted_at = at.toISOString();
    return true;
  }
  async beginProviderDispatch(id: string, attemptedAt: Date) {
    this.dispatches.push({ id, attemptedAt: attemptedAt.toISOString() });
    return { accountGeneration: this.dispatchGeneration };
  }
  async renewProviderDispatch(id: string, attemptedAt: Date) {
    this.dispatchRenewals.push({ id, attemptedAt: attemptedAt.toISOString() });
    if (this.dispatchRenewalFailure) throw this.dispatchRenewalFailure;
  }
  async failCanonical(
    id: string,
    kind: "rejected" | "failed" | "ambiguous",
    attemptedAt: Date,
  ) {
    if (
      this.root.delivery_status !== "sending" ||
      this.root.delivery_attempted_at !== attemptedAt.toISOString()
    ) {
      return;
    }
    this.root.delivery_status = kind;
    this.failures.push({ id, kind });
  }
  async completeCanonical(
    root: MessageRow,
    body: string,
    receipt: { externalDeliveryId: string; deliveredAt: string },
    attemptedAt: Date,
  ) {
    if (
      this.root.delivery_status !== "sending" ||
      this.root.delivery_attempted_at !== attemptedAt.toISOString()
    ) {
      throw new Error("Reply delivery claim was lost");
    }
    this.root.delivery_status = "delivered";
    this.root.sent_at = receipt.deliveredAt;
    this.canonical = message({
      id: "44444444-4444-4444-8444-444444444444",
      direction: "outbound",
      body,
      reply_to: root.id,
      reply_kind: "reply",
      status: "sent",
      sent_at: receipt.deliveredAt,
      delivery_status: "delivered",
      external_delivery_id: receipt.externalDeliveryId,
    });
    return this.canonical;
  }
  async createFollowUpIntent(
    root: MessageRow,
    body: string,
    requestId: string,
    at: Date,
  ) {
    const existing = this.followUpsByRequest.get(requestId);
    if (existing) return { message: existing, inserted: false };
    const id = `55555555-5555-4555-8555-${String(++this.sequence).padStart(12, "0")}`;
    const row = message({
      id,
      direction: "outbound",
      body,
      status: "approved",
      reply_to: root.id,
      reply_kind: "followup",
      delivery_request_id: requestId,
      delivery_status: "sending",
      delivery_attempted_at: at.toISOString(),
    });
    this.followUps.set(id, row);
    this.followUpsByRequest.set(requestId, row);
    return { message: row, inserted: true };
  }
  async loadFollowUp(id: string) {
    return this.followUps.get(id) ?? null;
  }
  async claimFollowUp(row: MessageRow, at: Date) {
    const staleSending =
      row.delivery_status === "sending" &&
      typeof row.delivery_attempted_at === "string" &&
      Date.parse(row.delivery_attempted_at) < at.getTime() - 5 * 60_000;
    if (
      !staleSending &&
      !["rejected", "failed", "ambiguous"].includes(row.delivery_status ?? "")
    ) {
      return false;
    }
    row.delivery_status = "sending";
    row.delivery_attempted_at = at.toISOString();
    return true;
  }
  async failFollowUp(
    id: string,
    kind: "rejected" | "failed" | "ambiguous",
    attemptedAt: Date,
  ) {
    const row = this.followUps.get(id)!;
    if (
      row.delivery_status !== "sending" ||
      row.delivery_attempted_at !== attemptedAt.toISOString()
    ) {
      return;
    }
    row.delivery_status = kind;
    row.status = "approved";
    this.failures.push({ id, kind });
  }
  async completeFollowUp(
    id: string,
    receipt: { externalDeliveryId: string; deliveredAt: string },
    attemptedAt: Date,
  ) {
    const row = this.followUps.get(id)!;
    if (
      row.delivery_status !== "sending" ||
      row.delivery_attempted_at !== attemptedAt.toISOString()
    ) {
      throw new Error("Follow-up delivery claim was lost");
    }
    row.delivery_status = "delivered";
    row.status = "sent";
    row.sent_at = receipt.deliveredAt;
    row.external_delivery_id = receipt.externalDeliveryId;
    return row;
  }
}

describe("message delivery transport", () => {
  it("delivers an approved reply once using the exact external parent identifier", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    repository.root.ebay_account_generation =
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const first = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      body: "Yes, it includes the charger.",
    });
    const replay = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      body: "Yes, it includes the charger.",
    });

    expect(first.id).toBe(replay.id);
    expect(adapter.replies).toHaveLength(1);
    expect(adapter.replies[0]).toMatchObject({
      accountGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      externalParentId: "exact-question-parent-42",
      externalListingId: "110011001100",
      externalBuyerId: "buyer-public-id",
      idempotencyKey: ROOT_ID,
    });
    expect(repository.dispatches).toHaveLength(1);
    expect(adapter.replies[0]?.externalParentId).not.toBe(
      repository.root.external_message_id,
    );
    expect(repository.root.delivery_status).toBe("delivered");
  });

  it("does not treat a cross-marketplace row as an acknowledged eBay reply", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    repository.canonical = message({
      id: "55555555-5555-4555-8555-555555555555",
      direction: "outbound",
      reply_to: ROOT_ID,
      reply_kind: "reply",
      marketplace: "simulated",
      delivery_status: "delivered",
      external_delivery_id: null,
    });

    await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      body: "Yes, it includes the charger.",
    });

    expect(adapter.replies).toHaveLength(1);
    expect(repository.canonical?.marketplace).toBe("ebay");
    expect(repository.canonical?.external_delivery_id).toBeTruthy();
  });

  it("keeps rejected/ambiguous delivery visible and retryable without claiming success", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    adapter.replyFailure = new MarketplaceDeliveryError(
      "ambiguous",
      "connection closed",
    );

    const error = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MessageDeliveryAttemptError);
    expect((error as MessageDeliveryAttemptError).kind).toBe("ambiguous");
    expect(repository.canonical).toBeNull();
    expect(repository.root.sent_at).toBeNull();
    expect(repository.root.delivery_status).toBe("ambiguous");
    expect(adapter.replies).toHaveLength(1);

    adapter.replyFailure = undefined;
    await expect(
      sendCanonicalReply({
        repository,
        adapter,
        messageId: ROOT_ID,
        retry: true,
      }),
    ).rejects.toThrow("Confirm the duplicate-delivery risk");
    expect(adapter.replies).toHaveLength(1);

    const delivered = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      retry: true,
      confirmDuplicateRisk: true,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.replies).toHaveLength(2);
  });

  it("requires duplicate-risk confirmation before reclaiming a stale canonical send", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    repository.root = message({
      status: "sent",
      delivery_status: "sending",
      delivery_attempted_at: "2026-07-13T11:54:00.000Z",
    });
    const now = () => new Date("2026-07-13T12:00:00.000Z");

    await expect(
      sendCanonicalReply({
        repository,
        adapter,
        messageId: ROOT_ID,
        retry: true,
        now,
      }),
    ).rejects.toThrow("Confirm the duplicate-delivery risk");
    expect(adapter.replies).toHaveLength(0);

    await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      retry: true,
      confirmDuplicateRisk: true,
      now,
    });
    expect(adapter.replies).toHaveLength(1);
  });

  it("ignores a late canonical failure from a reclaimed delivery attempt", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    let rejectFirst!: (error: Error) => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstReceipt = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    adapter.replyToQuestion = async () => {
      calls += 1;
      if (calls === 1) {
        enteredFirst();
        return firstReceipt;
      }
      return {
        externalDeliveryId: "retry-delivered",
        deliveredAt: "2026-07-13T12:06:00.000Z",
      };
    };

    const first = sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    }).catch((error: unknown) => error);
    await firstEntered;

    await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      retry: true,
      confirmDuplicateRisk: true,
      now: () => new Date("2026-07-13T12:06:00.000Z"),
    });
    rejectFirst(new MarketplaceDeliveryError("ambiguous", "late failure"));
    await first;

    expect(repository.root.delivery_status).toBe("delivered");
    expect(repository.canonical?.external_delivery_id).toBe("retry-delivered");
  });

  it("deduplicates a seller-authored follow-up request and preserves delivery identity", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });

    const first = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "I also found the carrying case.",
      requestId: "client-followup-request-7",
    });
    const replay = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "I also found the carrying case.",
      requestId: "client-followup-request-7",
    });

    expect(replay.id).toBe(first.id);
    expect(adapter.followUps).toHaveLength(1);
    expect(adapter.followUps[0]).toMatchObject({
      externalConversationId: "commerce-conversation-9",
      externalParentId: "exact-question-parent-42",
      idempotencyKey: "client-followup-request-7",
    });
    expect(first.delivery_request_id).toBe("client-followup-request-7");
    expect(first.external_delivery_id).toBe(
      "mock-followup-client-followup-request-7",
    );
  });

  it("rejects reusing a follow-up request id for different text", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });

    await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "I also found the carrying case.",
      requestId: "client-followup-request-7",
    });

    await expect(
      sendSellerFollowUp({
        repository,
        adapter,
        conversationId: ROOT_ID,
        body: "The case has a small scratch.",
        requestId: "client-followup-request-7",
      }),
    ).rejects.toBeInstanceOf(MessageDeliveryConflictError);
    expect(adapter.followUps).toHaveLength(1);
  });

  it("retries a failed follow-up by its persisted local identity", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });
    adapter.followUpFailure = new MarketplaceDeliveryError("failed", "system error");
    const failed = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "One more detail.",
      requestId: "request-9",
    }).catch(() => repository.followUpsByRequest.get("request-9")!);
    expect(failed.delivery_status).toBe("failed");
    expect(failed.sent_at).toBeNull();

    adapter.followUpFailure = undefined;
    const delivered = await retryFollowUpDelivery({
      repository,
      adapter,
      messageId: failed.id,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.followUps).toHaveLength(2);
  });

  it("requires duplicate-risk confirmation before retrying an ambiguous follow-up", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });
    adapter.followUpFailure = new MarketplaceDeliveryError(
      "ambiguous",
      "connection closed",
    );
    const ambiguous = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "One more detail.",
      requestId: "request-ambiguous",
    }).catch(() => repository.followUpsByRequest.get("request-ambiguous")!);

    adapter.followUpFailure = undefined;
    await expect(
      retryFollowUpDelivery({
        repository,
        adapter,
        messageId: ambiguous.id,
      }),
    ).rejects.toThrow("Confirm the duplicate-delivery risk");
    expect(adapter.followUps).toHaveLength(1);

    const delivered = await retryFollowUpDelivery({
      repository,
      adapter,
      messageId: ambiguous.id,
      confirmDuplicateRisk: true,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.followUps).toHaveLength(2);
  });

  it("requires duplicate-risk confirmation before reclaiming a stale follow-up send", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });
    const stale = message({
      id: "55555555-5555-4555-8555-000000000099",
      direction: "outbound",
      body: "One more detail.",
      status: "approved",
      reply_to: ROOT_ID,
      reply_kind: "followup",
      delivery_request_id: "request-stale",
      delivery_status: "sending",
      delivery_attempted_at: "2026-07-13T11:54:00.000Z",
    });
    repository.followUps.set(stale.id, stale);
    const now = () => new Date("2026-07-13T12:00:00.000Z");

    await expect(
      retryFollowUpDelivery({
        repository,
        adapter,
        messageId: stale.id,
        now,
      }),
    ).rejects.toThrow("Confirm the duplicate-delivery risk");
    expect(adapter.followUps).toHaveLength(0);

    await retryFollowUpDelivery({
      repository,
      adapter,
      messageId: stale.id,
      confirmDuplicateRisk: true,
      now,
    });
    expect(adapter.followUps).toHaveLength(1);
  });

  it("ignores a late follow-up failure from a reclaimed delivery attempt", async () => {
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({
      repository,
      adapter: new MockMarketplaceMessagingAdapter(),
      messageId: ROOT_ID,
    });
    const adapter = new MockMarketplaceMessagingAdapter();
    let rejectFirst!: (error: Error) => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstReceipt = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    adapter.sendFollowUp = async () => {
      calls += 1;
      if (calls === 1) {
        enteredFirst();
        return firstReceipt;
      }
      return {
        externalDeliveryId: "followup-retry-delivered",
        deliveredAt: "2026-07-13T12:06:00.000Z",
      };
    };

    const first = sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "One more detail.",
      requestId: "request-race",
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    }).catch((error: unknown) => error);
    await firstEntered;
    const pending = repository.followUpsByRequest.get("request-race")!;

    await retryFollowUpDelivery({
      repository,
      adapter,
      messageId: pending.id,
      confirmDuplicateRisk: true,
      now: () => new Date("2026-07-13T12:06:00.000Z"),
    });
    rejectFirst(new MarketplaceDeliveryError("ambiguous", "late failure"));
    await first;

    expect(pending.delivery_status).toBe("delivered");
    expect(pending.external_delivery_id).toBe("followup-retry-delivered");
  });

  it.each(["canonical", "follow-up"])(
    "aborts an in-flight %s dispatch when its durable lease cannot renew",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const repository = new MemoryDeliveryRepository();
        repository.dispatchRenewalFailure = new Error("account erasure started");
        const adapter = new MockMarketplaceMessagingAdapter();
        let observedSignal: AbortSignal | undefined;
        const waitForAbort = async (input: { signal?: AbortSignal }) => {
          observedSignal = input.signal;
          return await new Promise<never>((_resolve, reject) => {
            if (!input.signal) {
              reject(new Error("provider dispatch had no cancellation signal"));
              return;
            }
            input.signal.addEventListener(
              "abort",
              () => reject(new MarketplaceDeliveryError(
                "ambiguous",
                "provider dispatch lease ended",
              )),
              { once: true },
            );
          });
        };
        adapter.replyToQuestion = waitForAbort;
        adapter.sendFollowUp = waitForAbort;

        let delivery: Promise<unknown>;
        if (kind === "canonical") {
          delivery = sendCanonicalReply({
            repository,
            adapter,
            messageId: ROOT_ID,
          }).catch((error: unknown) => error);
        } else {
          repository.canonical = message({
            id: "44444444-4444-4444-8444-444444444444",
            direction: "outbound",
            body: "Delivered root reply",
            reply_to: ROOT_ID,
            reply_kind: "reply",
            status: "sent",
            delivery_status: "delivered",
            external_delivery_id: "provider-root-reply",
          });
          delivery = sendSellerFollowUp({
            repository,
            adapter,
            conversationId: ROOT_ID,
            body: "One more detail.",
            requestId: "lease-renewal-followup",
          }).catch((error: unknown) => error);
        }

        await vi.advanceTimersByTimeAsync(60_000);
        const error = await delivery;

        expect(repository.dispatchRenewals).toHaveLength(1);
        expect(observedSignal?.aborted).toBe(true);
        expect(error).toBeInstanceOf(MessageDeliveryAttemptError);
        expect((error as MessageDeliveryAttemptError).kind).toBe("ambiguous");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uploads staged photos and includes their provider references in the exact reply", async () => {
    const repository = new MemoryDeliveryRepository();
    const adapter = new MockMarketplaceMessagingAdapter();
    const photo = attachment();
    const linked: Array<{ requestId: string; messageId: string }> = [];
    const photoRepository = repository as MemoryDeliveryRepository & Required<Pick<
      DeliveryRepository,
      "listDeliveryPhotos" | "readDeliveryPhoto" | "saveHostedPhoto" | "linkDeliveredPhotos"
    >>;
    photoRepository.listDeliveryPhotos = async (requestId) =>
      requestId === ROOT_ID ? [photo] : [];
    photoRepository.readDeliveryPhoto = async () =>
      new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    photoRepository.saveHostedPhoto = async (row, hosted) => {
      row.provider_media_id = hosted.providerMediaId;
      row.provider_url = hosted.mediaUrl;
      row.delivery_status = "uploaded";
    };
    photoRepository.linkDeliveredPhotos = async (requestId, messageId) => {
      linked.push({ requestId, messageId });
    };

    const delivered = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
    });

    expect(adapter.uploads).toHaveLength(1);
    expect(adapter.replies[0]?.externalParentId).toBe("exact-question-parent-42");
    expect(adapter.replies[0]?.media).toEqual([
      expect.objectContaining({
        providerMediaId: expect.stringContaining("mock-photo-"),
        mediaType: "IMAGE",
      }),
    ]);
    expect(linked).toEqual([{ requestId: ROOT_ID, messageId: delivered.id }]);
  });

  it("never downgrades a failed photo upload to text-only success", async () => {
    const repository = new MemoryDeliveryRepository();
    const adapter = new MockMarketplaceMessagingAdapter();
    adapter.uploadFailure = new MarketplaceDeliveryError("rejected", "bad image");
    const photoRepository = repository as MemoryDeliveryRepository & Required<Pick<
      DeliveryRepository,
      "listDeliveryPhotos" | "readDeliveryPhoto" | "saveHostedPhoto" | "failDeliveryPhotos"
    >>;
    photoRepository.listDeliveryPhotos = async () => [attachment()];
    photoRepository.readDeliveryPhoto = async () =>
      new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    photoRepository.saveHostedPhoto = async () => undefined;
    const photoFailures: string[] = [];
    photoRepository.failDeliveryPhotos = async (_requestId, kind) => {
      photoFailures.push(kind);
    };

    const error = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MessageDeliveryAttemptError);
    expect((error as MessageDeliveryAttemptError).kind).toBe("rejected");
    expect(adapter.replies).toHaveLength(0);
    expect(photoFailures).toEqual(["rejected"]);
  });

  it("reuses acknowledged photo uploads after a later photo fails", async () => {
    const repository = new MemoryDeliveryRepository();
    const adapter = new MockMarketplaceMessagingAdapter();
    const photos = [
      attachment(),
      attachment({
        id: "88888888-8888-4888-8888-888888888888",
        position: 1,
        original_name: "detail.jpg",
      }),
    ];
    const photoRepository = repository as MemoryDeliveryRepository & Required<Pick<
      DeliveryRepository,
      "listDeliveryPhotos" | "readDeliveryPhoto" | "saveHostedPhoto" | "failDeliveryPhotos"
    >>;
    photoRepository.listDeliveryPhotos = async () => photos;
    photoRepository.readDeliveryPhoto = async () =>
      new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    photoRepository.saveHostedPhoto = async (row, hosted) => {
      row.provider_media_id = hosted.providerMediaId;
      row.provider_url = hosted.mediaUrl;
    };
    photoRepository.failDeliveryPhotos = async () => undefined;
    const upload = adapter.uploadPhoto.bind(adapter);
    let attempts = 0;
    adapter.uploadPhoto = async (input) => {
      attempts += 1;
      if (attempts === 2) {
        adapter.uploads.push(input);
        throw new MarketplaceDeliveryError("rejected", "second photo rejected");
      }
      return upload(input);
    };

    await expect(sendCanonicalReply({ repository, adapter, messageId: ROOT_ID }))
      .rejects.toMatchObject({ kind: "rejected" });
    expect(adapter.replies).toHaveLength(0);
    expect(photos[0]?.provider_media_id).toBeTruthy();
    expect(photos[1]?.provider_media_id).toBeNull();

    const delivered = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      retry: true,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.uploads).toHaveLength(3);
    expect(adapter.replies[0]?.media).toHaveLength(2);
  });
});

function attachment(overrides: Partial<MessageAttachmentRow> = {}): MessageAttachmentRow {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    user_id: "user_a",
    conversation_root_id: ROOT_ID,
    message_id: null,
    delivery_request_id: ROOT_ID,
    position: 0,
    direction: "outbound",
    media_type: "image/jpeg",
    byte_size: 4,
    original_name: "photo.jpg",
    content_sha256: "374ffede23adbc8bc625205f4bf86750807ffb6ce71fc7d10cac8bded0872bf5",
    storage_path: `user_a/${ROOT_ID}/photo.jpg`,
    provider_media_id: null,
    provider_url: null,
    provider_expires_at: null,
    delivery_status: "staged",
    delivery_error: null,
    created_at: "2026-07-14T12:00:00.000Z",
    updated_at: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}
