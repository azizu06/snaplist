import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type {
  MarketplaceDeliveryFailureKind,
  MarketplaceHostedPhoto,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
} from "@/lib/marketplace/messaging";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import {
  applyEbayMessageWrite,
  applyScheduledEbayMessageWrite,
  beginEbayMessageWrite,
  beginScheduledEbayMessageWrite,
  claimEbayMessageWriteWithPhotos,
  claimScheduledEbayMessageWriteWithPhotos,
  completeEbayMessageWriteWithPhotos,
  completeScheduledEbayMessageWriteWithPhotos,
  readScheduledEbayMessagePolicy,
} from "./ebay-server-write";
import { MESSAGE_PHOTO_BUCKET, validateMessagePhoto } from "./attachments";
import {
  messageAttachmentRowSchema,
  messageRowSchema,
  type MessageAttachmentRow,
  type MessageRow,
} from "./types";

const PG_UNIQUE_VIOLATION = "23505";
const DELIVERY_LEASE_MS = 5 * 60_000;
const PROVIDER_DISPATCH_HEARTBEAT_MS = 60_000;
const PROVIDER_PHOTO_EXPIRY_SAFETY_MS = 5 * 60_000;

export class MessageDeliveryConflictError extends Error {
  constructor(message = "This message delivery was already claimed") {
    super(message);
    this.name = "MessageDeliveryConflictError";
  }
}

export class MessageDeliveryAttemptError extends Error {
  constructor(
    public readonly kind: MarketplaceDeliveryFailureKind,
    message = "Marketplace delivery did not complete",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MessageDeliveryAttemptError";
  }
}

export interface DeliveryRepository {
  loadConversationRoot(messageId: string): Promise<MessageRow | null>;
  canonicalDelivered(root: MessageRow): Promise<MessageRow | null>;
  claimCanonical(
    root: MessageRow,
    body: string,
    at: Date,
    retry: boolean,
    expectedPhotoIds: readonly string[],
    deliveryActor?: "automatic" | "seller",
    marketplaceObservedAt?: string,
    questionObservedAt?: string,
  ): Promise<boolean>;
  beginProviderDispatch(
    messageId: string,
    attemptedAt: Date,
  ): Promise<{ accountGeneration: string }>;
  renewProviderDispatch(messageId: string, attemptedAt: Date): Promise<void>;
  failCanonical(
    messageId: string,
    kind: MarketplaceDeliveryFailureKind,
    attemptedAt: Date,
  ): Promise<void>;
  completeCanonical(
    root: MessageRow,
    body: string,
    receipt: MarketplaceDeliveryReceipt,
    attemptedAt: Date,
  ): Promise<MessageRow>;
  createFollowUpIntent(
    root: MessageRow,
    body: string,
    requestId: string,
    at: Date,
    expectedPhotoIds: readonly string[],
  ): Promise<{ message: MessageRow; inserted: boolean }>;
  loadFollowUp(messageId: string): Promise<MessageRow | null>;
  claimFollowUp(message: MessageRow, at: Date): Promise<boolean>;
  failFollowUp(
    messageId: string,
    kind: MarketplaceDeliveryFailureKind,
    attemptedAt: Date,
  ): Promise<void>;
  completeFollowUp(
    messageId: string,
    receipt: MarketplaceDeliveryReceipt,
    attemptedAt: Date,
    deliveryRequestId?: string,
  ): Promise<MessageRow>;
  listDeliveryPhotos?(deliveryRequestId: string): Promise<MessageAttachmentRow[]>;
  readDeliveryPhoto?(photo: MessageAttachmentRow): Promise<Uint8Array>;
  saveHostedPhoto?(
    photo: MessageAttachmentRow,
    hosted: MarketplaceHostedPhoto,
  ): Promise<void>;
  linkDeliveredPhotos?(
    deliveryRequestId: string,
    messageId: string,
  ): Promise<void>;
  failDeliveryPhotos?(
    deliveryRequestId: string,
    kind: MarketplaceDeliveryFailureKind,
  ): Promise<void>;
}

interface SendCanonicalBaseInput {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  messageId: string;
  body?: string;
  confirmDuplicateRisk?: boolean;
  deliveryActor?: "automatic" | "seller";
  marketplaceObservedAt?: string;
  questionObservedAt?: string;
  now?: () => Date;
}

export type SendCanonicalInput = SendCanonicalBaseInput & (
  | { retry: true; expectedPhotoIds?: readonly string[] }
  | { retry?: false; expectedPhotoIds: readonly string[] }
);

export async function sendCanonicalReply(
  input: SendCanonicalInput,
): Promise<MessageRow> {
  const root = await input.repository.loadConversationRoot(input.messageId);
  if (!root || root.direction !== "inbound") {
    throw new MessageDeliveryConflictError("Buyer question not found");
  }
  const alreadyDelivered = await input.repository.canonicalDelivered(root);
  if (alreadyDelivered && canonicalDeliveryMatches(root, alreadyDelivered)) {
    await assertDeliveredPhotoReplay(
      input.repository,
      root.id,
      alreadyDelivered.id,
    );
    return alreadyDelivered;
  }
  const at = input.now?.() ?? new Date();
  if (
    input.retry === true &&
    deliveryIsUnconfirmed(root, at) &&
    input.confirmDuplicateRisk !== true
  ) {
    throw new MessageDeliveryConflictError(
      "Confirm the duplicate-delivery risk before retrying an unconfirmed reply",
    );
  }
  const body = (input.body ?? root.draft_reply ?? "").trim();
  if (!body) throw new Error("A non-empty approved reply is required");
  if (input.retry !== true && input.expectedPhotoIds === undefined) {
    throw new Error("The approved photo set is required");
  }
  const expectedPhotoIds = input.expectedPhotoIds ?? (
    await input.repository.listDeliveryPhotos?.(root.id) ?? []
  ).map((photo) => photo.id);

  const claimed = await input.repository.claimCanonical(
    root,
    body,
    at,
    input.retry === true,
    expectedPhotoIds,
    input.deliveryActor ?? "seller",
    input.marketplaceObservedAt,
    input.questionObservedAt,
  );
  if (!claimed) throw new MessageDeliveryConflictError();

  let receipt: MarketplaceDeliveryReceipt;
  try {
    const dispatch = await input.repository.beginProviderDispatch(root.id, at);
    receipt = await withProviderDispatchLease(
      input.repository,
      root.id,
      at,
      async (signal) => {
        const media = await prepareDeliveryPhotos(
          input.repository,
          input.adapter,
          root.id,
          dispatch.accountGeneration,
          signal,
          at,
        );
        return input.adapter.replyToQuestion(deliveryInput(
          root,
          body,
          root.id,
          dispatch.accountGeneration,
          signal,
          media,
        ));
      },
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await input.repository.failDeliveryPhotos?.(root.id, kind).catch(() => undefined);
    await input.repository.failCanonical(root.id, kind, at);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }

  try {
    const message = await input.repository.completeCanonical(root, body, receipt, at);
    await input.repository.linkDeliveredPhotos?.(root.id, message.id);
    return message;
  } catch (error) {
    // eBay acknowledged delivery but local persistence did not complete. Keep
    // the question visibly ambiguous; a replay first checks for an outbound row.
    await input.repository
      .failCanonical(root.id, "ambiguous", at)
      .catch(() => undefined);
    throw new MessageDeliveryAttemptError("ambiguous", undefined, {
      cause: error,
    });
  }
}

export interface SendFollowUpInput {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  conversationId: string;
  body: string;
  requestId: string;
  expectedPhotoIds: readonly string[];
  now?: () => Date;
}

export async function assertSellerFollowUpEligible(
  repository: DeliveryRepository,
  conversationId: string,
): Promise<MessageRow> {
  const root = await repository.loadConversationRoot(conversationId);
  const delivered = root ? await repository.canonicalDelivered(root) : null;
  if (!root || !delivered || !canonicalDeliveryMatches(root, delivered)) {
    throw new MessageDeliveryConflictError(
      "Reply to this question before sending a follow-up",
    );
  }
  return root;
}

export async function sendSellerFollowUp(
  input: SendFollowUpInput,
): Promise<MessageRow> {
  const root = await assertSellerFollowUpEligible(
    input.repository,
    input.conversationId,
  );
  const body = input.body.trim();
  if (!body) throw new Error("A non-empty follow-up is required");
  const at = input.now?.() ?? new Date();
  const intent = await input.repository.createFollowUpIntent(
    root,
    body,
    input.requestId,
    at,
    input.expectedPhotoIds,
  );
  // An HTTP/client replay of the same request key returns the durable intent
  // without dispatching another external side effect. Explicit retry uses the
  // persisted local message id through retryFollowUpDelivery below.
  if (!intent.inserted) {
    if (
      intent.message.reply_kind !== "followup" ||
      intent.message.reply_to !== root.id ||
      intent.message.body !== body
    ) {
      throw new MessageDeliveryConflictError(
        "This follow-up request id belongs to different content",
      );
    }
    if (intent.message.delivery_status === "delivered") {
      await assertDeliveredPhotoReplay(
        input.repository,
        input.requestId,
        intent.message.id,
      );
    }
    return intent.message;
  }
  return deliverFollowUp(
    input.repository,
    input.adapter,
    root,
    intent.message,
    at,
  );
}

async function assertDeliveredPhotoReplay(
  repository: DeliveryRepository,
  deliveryRequestId: string,
  messageId: string,
): Promise<void> {
  if (!repository.listDeliveryPhotos) return;
  const photos = await repository.listDeliveryPhotos(deliveryRequestId);
  if (
    photos.some(
      (photo) =>
        photo.message_id !== messageId || photo.delivery_status !== "delivered",
    )
  ) {
    throw new MessageDeliveryConflictError(
      "This delivery request is already complete with different photos",
    );
  }
}

export async function retryFollowUpDelivery(input: {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  messageId: string;
  confirmDuplicateRisk?: boolean;
  now?: () => Date;
}): Promise<MessageRow> {
  const message = await input.repository.loadFollowUp(input.messageId);
  if (!message || message.reply_kind !== "followup" || !message.reply_to) {
    throw new MessageDeliveryConflictError("Follow-up message not found");
  }
  if (message.delivery_status === "delivered") return message;
  const at = input.now?.() ?? new Date();
  if (
    deliveryIsUnconfirmed(message, at) &&
    input.confirmDuplicateRisk !== true
  ) {
    throw new MessageDeliveryConflictError(
      "Confirm the duplicate-delivery risk before retrying an unconfirmed follow-up",
    );
  }
  const root = await input.repository.loadConversationRoot(message.reply_to);
  if (!root) throw new MessageDeliveryConflictError("Conversation not found");
  const claimed = await input.repository.claimFollowUp(
    message,
    at,
  );
  if (!claimed) throw new MessageDeliveryConflictError();
  return deliverFollowUp(input.repository, input.adapter, root, message, at);
}

async function deliverFollowUp(
  repository: DeliveryRepository,
  adapter: MarketplaceMessagingAdapter,
  root: MessageRow,
  message: MessageRow,
  attemptedAt: Date,
): Promise<MessageRow> {
  let receipt: MarketplaceDeliveryReceipt;
  try {
    const dispatch = await repository.beginProviderDispatch(
      message.id,
      attemptedAt,
    );
    receipt = await withProviderDispatchLease(
      repository,
      message.id,
      attemptedAt,
      async (signal) => {
        const requestId = message.delivery_request_id ?? message.id;
        const media = await prepareDeliveryPhotos(
          repository,
          adapter,
          requestId,
          dispatch.accountGeneration,
          signal,
          attemptedAt,
        );
        return adapter.sendFollowUp(deliveryInput(
          root,
          message.body,
          requestId,
          dispatch.accountGeneration,
          signal,
          media,
        ));
      },
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await repository
      .failDeliveryPhotos?.(message.delivery_request_id ?? message.id, kind)
      .catch(() => undefined);
    await repository.failFollowUp(message.id, kind, attemptedAt);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }
  try {
    const delivered = await repository.completeFollowUp(
      message.id,
      receipt,
      attemptedAt,
      message.delivery_request_id ?? message.id,
    );
    await repository.linkDeliveredPhotos?.(
      message.delivery_request_id ?? message.id,
      delivered.id,
    );
    return delivered;
  } catch (error) {
    await repository
      .failFollowUp(message.id, "ambiguous", attemptedAt)
      .catch(() => undefined);
    throw new MessageDeliveryAttemptError("ambiguous", undefined, {
      cause: error,
    });
  }
}

function deliveryInput(
  root: MessageRow,
  body: string,
  idempotencyKey: string,
  accountGeneration: string,
  signal?: AbortSignal,
  media?: MarketplaceHostedPhoto[],
) {
  const isSimulated = (root.marketplace ?? "simulated") === "simulated";
  const parent = root.external_parent_id ?? (isSimulated ? root.id : null);
  const conversation =
    root.external_conversation_id ?? (isSimulated ? root.id : null);
  const listing =
    root.external_listing_id ?? (isSimulated ? root.listing_id ?? root.id : null);
  const buyer = root.external_buyer_id ?? (isSimulated ? "simulated-buyer" : null);
  if (!parent || !conversation || !listing || !buyer) {
    throw new MarketplaceDeliveryError(
      "rejected",
      "Imported marketplace message is missing delivery identity",
    );
  }
  return {
    accountGeneration,
    signal,
    externalParentId: parent,
    externalConversationId: conversation,
    externalListingId: listing,
    externalBuyerId: buyer,
    body,
    idempotencyKey,
    ...(media?.length ? { media } : {}),
  };
}

async function prepareDeliveryPhotos(
  repository: DeliveryRepository,
  adapter: MarketplaceMessagingAdapter,
  deliveryRequestId: string,
  accountGeneration: string,
  signal: AbortSignal,
  attemptedAt: Date,
): Promise<MarketplaceHostedPhoto[]> {
  if (!repository.listDeliveryPhotos) return [];
  const photos = await repository.listDeliveryPhotos(deliveryRequestId);
  const hosted: MarketplaceHostedPhoto[] = [];
  for (const photo of photos) {
    if (
      photo.provider_media_id &&
      photo.provider_url &&
      providerPhotoReferenceIsReusable(photo.provider_expires_at, attemptedAt)
    ) {
      hosted.push({
        providerMediaId: photo.provider_media_id,
        mediaName: photo.original_name,
        mediaType: "IMAGE",
        mediaUrl: photo.provider_url,
        expiresAt: photo.provider_expires_at,
      });
      continue;
    }
    if (!repository.readDeliveryPhoto || !repository.saveHostedPhoto) {
      throw new MarketplaceDeliveryError("failed", "Photo storage is unavailable");
    }
    const bytes = await repository.readDeliveryPhoto(photo);
    if (!photo.media_type) {
      throw new MarketplaceDeliveryError("rejected", "Photo type is unavailable");
    }
    try {
      validateMessagePhoto({
        name: photo.original_name,
        type: photo.media_type,
        size: bytes.byteLength,
        bytes,
      });
    } catch (cause) {
      throw new MarketplaceDeliveryError("rejected", "Stored photo failed validation", {
        cause,
      });
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (!photo.content_sha256 || contentHash !== photo.content_sha256) {
      throw new MarketplaceDeliveryError("rejected", "Stored photo changed after approval");
    }
    const uploaded = await adapter.uploadPhoto({
      accountGeneration,
      signal,
      name: photo.original_name,
      mediaType: photo.media_type,
      bytes,
      idempotencyKey: `${deliveryRequestId}:${photo.position}:${photo.content_sha256 ?? photo.id}`,
    });
    await repository.saveHostedPhoto(photo, uploaded);
    hosted.push(uploaded);
  }
  return hosted;
}

function providerPhotoReferenceIsReusable(
  expiresAt: string | null,
  attemptedAt: Date,
): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) &&
    expiresAtMs > attemptedAt.getTime() + PROVIDER_PHOTO_EXPIRY_SAFETY_MS;
}

async function withProviderDispatchLease<T>(
  repository: DeliveryRepository,
  messageId: string,
  attemptedAt: Date,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = repository
      .renewProviderDispatch(messageId, attemptedAt)
      .catch((error: unknown) => controller.abort(error))
      .finally(() => {
        renewal = undefined;
      });
  }, PROVIDER_DISPATCH_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await dispatch(controller.signal);
  } finally {
    clearInterval(timer);
    await renewal?.catch(() => undefined);
  }
}

function deliveryFailureKind(error: unknown): MarketplaceDeliveryFailureKind {
  return error instanceof MarketplaceDeliveryError ? error.kind : "failed";
}

function deliveryIsUnconfirmed(message: MessageRow, at: Date): boolean {
  if (message.delivery_status === "ambiguous") return true;
  if (message.delivery_status !== "sending" || !message.delivery_attempted_at) {
    return false;
  }
  const attemptedAt = Date.parse(message.delivery_attempted_at);
  return (
    Number.isFinite(attemptedAt) &&
    attemptedAt < at.getTime() - DELIVERY_LEASE_MS
  );
}

function canonicalDeliveryMatches(root: MessageRow, reply: MessageRow): boolean {
  const rootMarketplace = root.marketplace ?? "simulated";
  const replyMarketplace = reply.marketplace ?? "simulated";
  if (
    reply.reply_to !== root.id ||
    reply.direction !== "outbound" ||
    replyMarketplace !== rootMarketplace ||
    reply.delivery_status !== "delivered"
  ) {
    return false;
  }
  return rootMarketplace !== "ebay" || Boolean(reply.external_delivery_id);
}

/** Supabase implementation; every statement is explicitly pinned to userId. */
export class SupabaseDeliveryRepository implements DeliveryRepository {
  private writeGeneration: Promise<string> | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
    private readonly serverManaged = false,
    private readonly serverWriteClient: SupabaseClient = supabase,
    private readonly scheduled = false,
  ) {}

  private getWriteGeneration(): Promise<string> {
    this.writeGeneration ??= this.scheduled
      ? beginScheduledEbayMessageWrite(this.serverWriteClient, this.userId)
      : beginEbayMessageWrite(this.serverWriteClient);
    return this.writeGeneration;
  }

  private async applyServerWrite<T>(
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const generation = await this.getWriteGeneration();
    return this.scheduled
      ? applyScheduledEbayMessageWrite<T>(
          this.serverWriteClient,
          this.userId,
          operation,
          payload,
          generation,
        )
      : applyEbayMessageWrite<T>(
          this.serverWriteClient,
          operation,
          payload,
          generation,
        );
  }

  async loadConversationRoot(messageId: string): Promise<MessageRow | null> {
    if (this.scheduled) {
      const data = await readScheduledEbayMessagePolicy<unknown>(
        this.serverWriteClient,
        this.userId,
        "delivery_root",
        { message_id: messageId },
      );
      return data ? messageRowSchema.parse(data) : null;
    }
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (error) throw new Error(`Failed to load buyer question: ${error.message}`);
    return data ? messageRowSchema.parse(data) : null;
  }

  async beginProviderDispatch(
    messageId: string,
    attemptedAt: Date,
  ): Promise<{ accountGeneration: string }> {
    if (!this.serverManaged) {
      return { accountGeneration: "simulated" };
    }
    const data = await this.applyServerWrite<{
      account_generation?: unknown;
    }>("begin_provider_dispatch", {
      message_id: messageId,
      attempted_at: attemptedAt.toISOString(),
    });
    if (typeof data.account_generation !== "string") {
      throw new Error("Failed to bind eBay provider dispatch to an account");
    }
    return { accountGeneration: data.account_generation };
  }

  async renewProviderDispatch(
    messageId: string,
    attemptedAt: Date,
  ): Promise<void> {
    if (!this.serverManaged) return;
    await this.applyServerWrite("renew_provider_dispatch", {
      message_id: messageId,
      attempted_at: attemptedAt.toISOString(),
    });
  }

  async canonicalDelivered(root: MessageRow): Promise<MessageRow | null> {
    if (this.scheduled) {
      const data = await readScheduledEbayMessagePolicy<unknown>(
        this.serverWriteClient,
        this.userId,
        "canonical_delivered",
        { message_id: root.id },
      );
      return data ? messageRowSchema.parse(data) : null;
    }
    let query = this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("reply_to", root.id)
      .eq("direction", "outbound")
      .eq("marketplace", root.marketplace ?? "simulated")
      .eq("delivery_status", "delivered")
      .or("reply_kind.is.null,reply_kind.eq.reply");
    if (root.marketplace === "ebay") {
      query = query.not("external_delivery_id", "is", null);
    }
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`Failed to read canonical reply: ${error.message}`);
    return data ? messageRowSchema.parse(data) : null;
  }

  async claimCanonical(
    root: MessageRow,
    body: string,
    at: Date,
    retry: boolean,
    expectedPhotoIds: readonly string[],
    deliveryActor: "automatic" | "seller" = "seller",
    marketplaceObservedAt?: string,
    questionObservedAt?: string,
  ): Promise<boolean> {
    if (this.serverManaged) {
      const payload = {
        message_id: root.id,
        body,
        at: at.toISOString(),
        retry,
        delivery_actor: deliveryActor,
        marketplace_observed_at: marketplaceObservedAt,
        question_observed_at: questionObservedAt,
      };
      const generation = await this.getWriteGeneration();
      return this.scheduled
        ? claimScheduledEbayMessageWriteWithPhotos<boolean>(
            this.serverWriteClient,
            this.userId,
            "claim_canonical",
            payload,
            generation,
            root.id,
            expectedPhotoIds,
          )
        : claimEbayMessageWriteWithPhotos<boolean>(
            this.serverWriteClient,
            "claim_canonical",
            payload,
            generation,
            root.id,
            expectedPhotoIds,
          );
    }
    let query = this.supabase
      .from("messages")
      .update({
        status: "sent",
        draft_reply: body,
        delivery_request_id: root.id,
        delivery_status: "sending",
        delivery_attempted_at: at.toISOString(),
        delivery_error: null,
        policy_delivery_actor: deliveryActor,
      })
      .eq("user_id", this.userId)
      .eq("id", root.id)
      .eq("direction", "inbound");
    if (retry) {
      const stale = new Date(at.getTime() - DELIVERY_LEASE_MS).toISOString();
      query = query.or(
        `delivery_status.in.(rejected,failed,ambiguous),and(delivery_status.eq.sending,delivery_attempted_at.lt.${stale})`,
      );
    } else {
      query = query.eq("status", "drafted");
    }
    const { data, error } = await query.select("id");
    if (error) throw new Error(`Failed to claim reply delivery: ${error.message}`);
    return data?.length === 1;
  }

  async failCanonical(
    messageId: string,
    kind: MarketplaceDeliveryFailureKind,
    attemptedAt: Date,
  ): Promise<void> {
    if (this.serverManaged) {
      await this.applyServerWrite("fail_canonical", {
        message_id: messageId,
        kind,
        attempted_at: attemptedAt.toISOString(),
      });
      return;
    }
    const { error } = await this.supabase
      .from("messages")
      .update({ delivery_status: kind, delivery_error: kind, sent_at: null })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("delivery_status", "sending")
      .eq("delivery_attempted_at", attemptedAt.toISOString());
    if (error) throw new Error(`Failed to persist reply failure: ${error.message}`);
  }

  async completeCanonical(
    root: MessageRow,
    body: string,
    receipt: MarketplaceDeliveryReceipt,
    attemptedAt: Date,
  ): Promise<MessageRow> {
    if (this.serverManaged) {
      const payload = {
        message_id: root.id,
        body,
        external_delivery_id: receipt.externalDeliveryId,
        delivered_at: receipt.deliveredAt,
        attempted_at: attemptedAt.toISOString(),
      };
      const generation = await this.getWriteGeneration();
      const data = this.scheduled
        ? await completeScheduledEbayMessageWriteWithPhotos<unknown>(
            this.serverWriteClient,
            this.userId,
            "complete_canonical",
            payload,
            generation,
            root.id,
          )
        : await completeEbayMessageWriteWithPhotos<unknown>(
            this.serverWriteClient,
            "complete_canonical",
            payload,
            generation,
            root.id,
          );
      return messageRowSchema.parse(data);
    }
    const { data, error } = await this.supabase
      .from("messages")
      .insert({
        user_id: this.userId,
        item_id: root.item_id,
        listing_id: root.listing_id,
        direction: "outbound",
        body,
        status: "sent",
        sent_at: receipt.deliveredAt,
        reply_to: root.id,
        reply_kind: "reply",
        marketplace: root.marketplace ?? "simulated",
        external_parent_id: root.external_parent_id ?? null,
        external_conversation_id: root.external_conversation_id ?? null,
        external_listing_id: root.external_listing_id ?? null,
        external_buyer_id: root.external_buyer_id ?? null,
        delivery_status: "delivered",
        external_delivery_id: receipt.externalDeliveryId,
        delivery_attempted_at: receipt.deliveredAt,
      })
      .select("*")
      .maybeSingle();
    if (error?.code === PG_UNIQUE_VIOLATION) {
      const existing = await this.canonicalDelivered(root);
      if (existing) return existing;
    }
    if (error || !data) {
      throw new Error(`Failed to persist delivered reply: ${error?.message ?? "no row"}`);
    }
    const { error: updateError } = await this.supabase
      .from("messages")
      .update({
        delivery_status: "delivered",
        delivery_error: null,
        sent_at: receipt.deliveredAt,
      })
      .eq("user_id", this.userId)
      .eq("id", root.id)
      .eq("delivery_status", "sending")
      .eq("delivery_attempted_at", attemptedAt.toISOString());
    if (updateError) {
      throw new Error(`Failed to finalize delivered question: ${updateError.message}`);
    }
    return messageRowSchema.parse(data);
  }

  async createFollowUpIntent(
    root: MessageRow,
    body: string,
    requestId: string,
    at: Date,
    expectedPhotoIds: readonly string[],
  ): Promise<{ message: MessageRow; inserted: boolean }> {
    if (this.serverManaged) {
      const result = await claimEbayMessageWriteWithPhotos<{
        message: unknown;
        inserted: boolean;
      }>(
        this.serverWriteClient,
        "create_followup",
        {
          root_id: root.id,
          body,
          request_id: requestId,
          at: at.toISOString(),
        },
        await this.getWriteGeneration(),
        requestId,
        expectedPhotoIds,
      );
      return {
        message: messageRowSchema.parse(result.message),
        inserted: result.inserted,
      };
    }
    const { data, error } = await this.supabase
      .from("messages")
      .insert({
        user_id: this.userId,
        item_id: root.item_id,
        listing_id: root.listing_id,
        direction: "outbound",
        body,
        status: "approved",
        reply_to: root.id,
        reply_kind: "followup",
        marketplace: root.marketplace ?? "simulated",
        external_parent_id: root.external_parent_id ?? null,
        external_conversation_id: root.external_conversation_id ?? null,
        external_listing_id: root.external_listing_id ?? null,
        external_buyer_id: root.external_buyer_id ?? null,
        delivery_request_id: requestId,
        delivery_status: "sending",
        delivery_attempted_at: at.toISOString(),
      })
      .select("*")
      .maybeSingle();
    if (!error && data) {
      return { message: messageRowSchema.parse(data), inserted: true };
    }
    if (error?.code !== PG_UNIQUE_VIOLATION) {
      throw new Error(`Failed to persist follow-up intent: ${error?.message ?? "no row"}`);
    }
    const { data: existing, error: readError } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("delivery_request_id", requestId)
      .maybeSingle();
    if (readError || !existing) {
      throw new Error(`Failed to recover follow-up intent: ${readError?.message ?? "no row"}`);
    }
    return { message: messageRowSchema.parse(existing), inserted: false };
  }

  async loadFollowUp(messageId: string): Promise<MessageRow | null> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("direction", "outbound")
      .eq("reply_kind", "followup")
      .maybeSingle();
    if (error) throw new Error(`Failed to load follow-up: ${error.message}`);
    return data ? messageRowSchema.parse(data) : null;
  }

  async claimFollowUp(message: MessageRow, at: Date): Promise<boolean> {
    if (this.serverManaged) {
      return this.applyServerWrite<boolean>("claim_followup", {
        message_id: message.id,
        at: at.toISOString(),
      });
    }
    const stale = new Date(at.getTime() - DELIVERY_LEASE_MS).toISOString();
    const { data, error } = await this.supabase
      .from("messages")
      .update({
        delivery_status: "sending",
        delivery_attempted_at: at.toISOString(),
        delivery_error: null,
      })
      .eq("user_id", this.userId)
      .eq("id", message.id)
      .or(
        `delivery_status.in.(rejected,failed,ambiguous),and(delivery_status.eq.sending,delivery_attempted_at.lt.${stale})`,
      )
      .select("id");
    if (error) throw new Error(`Failed to claim follow-up retry: ${error.message}`);
    return data?.length === 1;
  }

  async failFollowUp(
    messageId: string,
    kind: MarketplaceDeliveryFailureKind,
    attemptedAt: Date,
  ): Promise<void> {
    if (this.serverManaged) {
      await this.applyServerWrite("fail_followup", {
        message_id: messageId,
        kind,
        attempted_at: attemptedAt.toISOString(),
      });
      return;
    }
    const { error } = await this.supabase
      .from("messages")
      .update({
        status: "approved",
        delivery_status: kind,
        delivery_error: kind,
        sent_at: null,
      })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("delivery_status", "sending")
      .eq("delivery_attempted_at", attemptedAt.toISOString());
    if (error) throw new Error(`Failed to persist follow-up failure: ${error.message}`);
  }

  async completeFollowUp(
    messageId: string,
    receipt: MarketplaceDeliveryReceipt,
    attemptedAt: Date,
    deliveryRequestId = messageId,
  ): Promise<MessageRow> {
    if (this.serverManaged) {
      const data = await completeEbayMessageWriteWithPhotos<unknown>(
        this.serverWriteClient,
        "complete_followup",
        {
          message_id: messageId,
          external_delivery_id: receipt.externalDeliveryId,
          delivered_at: receipt.deliveredAt,
          attempted_at: attemptedAt.toISOString(),
        },
        await this.getWriteGeneration(),
        deliveryRequestId,
      );
      return messageRowSchema.parse(data);
    }
    const { data, error } = await this.supabase
      .from("messages")
      .update({
        status: "sent",
        sent_at: receipt.deliveredAt,
        delivery_status: "delivered",
        external_delivery_id: receipt.externalDeliveryId,
        delivery_error: null,
      })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("delivery_status", "sending")
      .eq("delivery_attempted_at", attemptedAt.toISOString())
      .select("*")
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to finalize follow-up: ${error?.message ?? "claim lost"}`);
    }
    return messageRowSchema.parse(data);
  }

  async listDeliveryPhotos(deliveryRequestId: string): Promise<MessageAttachmentRow[]> {
    const { data, error } = await this.serverWriteClient
      .from("message_attachments")
      .select("*")
      .eq("user_id", this.userId)
      .eq("delivery_request_id", deliveryRequestId)
      .eq("direction", "outbound")
      .order("position");
    if (error) throw new Error(`Failed to load delivery photos: ${error.message}`);
    return (data ?? []).map((row) => messageAttachmentRowSchema.parse(row));
  }

  async readDeliveryPhoto(photo: MessageAttachmentRow): Promise<Uint8Array> {
    if (photo.user_id !== this.userId || !photo.storage_path) {
      throw new Error("Delivery photo is not available to this tenant");
    }
    const { data, error } = await this.supabase.storage
      .from(MESSAGE_PHOTO_BUCKET)
      .download(photo.storage_path);
    if (error || !data) {
      throw new Error(`Failed to read delivery photo: ${error?.message ?? "missing object"}`);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async saveHostedPhoto(
    photo: MessageAttachmentRow,
    hosted: MarketplaceHostedPhoto,
  ): Promise<void> {
    const { data, error } = await this.serverWriteClient
      .from("message_attachments")
      .update({
        provider_media_id: hosted.providerMediaId,
        provider_url: hosted.mediaUrl,
        provider_expires_at: hosted.expiresAt,
        delivery_status: "uploaded",
        delivery_error: null,
      })
      .eq("user_id", this.userId)
      .eq("id", photo.id)
      .in("delivery_status", ["staged", "uploaded", "failed", "rejected", "ambiguous"])
      .select("id");
    if (error || data?.length !== 1) {
      throw new Error(`Failed to persist hosted photo: ${error?.message ?? "claim lost"}`);
    }
  }

  async linkDeliveredPhotos(
    deliveryRequestId: string,
    messageId: string,
  ): Promise<void> {
    const { error } = await this.serverWriteClient
      .from("message_attachments")
      .update({
        message_id: messageId,
        delivery_status: "delivered",
        delivery_error: null,
      })
      .eq("user_id", this.userId)
      .eq("delivery_request_id", deliveryRequestId)
      .eq("direction", "outbound");
    if (error) throw new Error(`Failed to finalize delivery photos: ${error.message}`);
  }

  async failDeliveryPhotos(
    deliveryRequestId: string,
    kind: MarketplaceDeliveryFailureKind,
  ): Promise<void> {
    const { error } = await this.serverWriteClient
      .from("message_attachments")
      .update({ delivery_status: kind, delivery_error: kind })
      .eq("user_id", this.userId)
      .eq("delivery_request_id", deliveryRequestId)
      .eq("direction", "outbound")
      .neq("delivery_status", "delivered");
    if (error) throw new Error(`Failed to persist photo failure: ${error.message}`);
  }
}
