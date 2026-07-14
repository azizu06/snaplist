import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MarketplaceDeliveryFailureKind,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
} from "@/lib/marketplace/messaging";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import {
  applyEbayMessageWrite,
  beginEbayMessageWrite,
} from "./ebay-server-write";
import { messageRowSchema, type MessageRow } from "./types";

const PG_UNIQUE_VIOLATION = "23505";
const DELIVERY_LEASE_MS = 5 * 60_000;
const PROVIDER_DISPATCH_HEARTBEAT_MS = 60_000;

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
  ): Promise<MessageRow>;
}

export interface SendCanonicalInput {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  messageId: string;
  body?: string;
  retry?: boolean;
  confirmDuplicateRisk?: boolean;
  now?: () => Date;
}

export async function sendCanonicalReply(
  input: SendCanonicalInput,
): Promise<MessageRow> {
  const root = await input.repository.loadConversationRoot(input.messageId);
  if (!root || root.direction !== "inbound") {
    throw new MessageDeliveryConflictError("Buyer question not found");
  }
  const alreadyDelivered = await input.repository.canonicalDelivered(root);
  if (alreadyDelivered && canonicalDeliveryMatches(root, alreadyDelivered)) {
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

  const claimed = await input.repository.claimCanonical(
    root,
    body,
    at,
    input.retry === true,
  );
  if (!claimed) throw new MessageDeliveryConflictError();

  let receipt: MarketplaceDeliveryReceipt;
  try {
    const dispatch = await input.repository.beginProviderDispatch(root.id, at);
    receipt = await withProviderDispatchLease(
      input.repository,
      root.id,
      at,
      (signal) => input.adapter.replyToQuestion(
        deliveryInput(
          root,
          body,
          root.id,
          dispatch.accountGeneration,
          signal,
        ),
      ),
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await input.repository.failCanonical(root.id, kind, at);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }

  try {
    return await input.repository.completeCanonical(root, body, receipt, at);
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
  now?: () => Date;
}

export async function sendSellerFollowUp(
  input: SendFollowUpInput,
): Promise<MessageRow> {
  const root = await input.repository.loadConversationRoot(input.conversationId);
  const delivered = root
    ? await input.repository.canonicalDelivered(root)
    : null;
  if (!root || !delivered || !canonicalDeliveryMatches(root, delivered)) {
    throw new MessageDeliveryConflictError(
      "Reply to this question before sending a follow-up",
    );
  }
  const body = input.body.trim();
  if (!body) throw new Error("A non-empty follow-up is required");
  const at = input.now?.() ?? new Date();
  const intent = await input.repository.createFollowUpIntent(
    root,
    body,
    input.requestId,
    at,
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
      (signal) => adapter.sendFollowUp(
        deliveryInput(
          root,
          message.body,
          message.delivery_request_id ?? message.id,
          dispatch.accountGeneration,
          signal,
        ),
      ),
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await repository.failFollowUp(message.id, kind, attemptedAt);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }
  try {
    return await repository.completeFollowUp(message.id, receipt, attemptedAt);
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
  };
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
  ) {}

  private getWriteGeneration(): Promise<string> {
    this.writeGeneration ??= beginEbayMessageWrite(this.serverWriteClient);
    return this.writeGeneration;
  }

  private async applyServerWrite<T>(
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    return applyEbayMessageWrite<T>(
      this.serverWriteClient,
      operation,
      payload,
      await this.getWriteGeneration(),
    );
  }

  async loadConversationRoot(messageId: string): Promise<MessageRow | null> {
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
  ): Promise<boolean> {
    if (this.serverManaged) {
      return this.applyServerWrite<boolean>("claim_canonical", {
        message_id: root.id,
        body,
        at: at.toISOString(),
        retry,
      });
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
      const data = await this.applyServerWrite<unknown>("complete_canonical", {
        message_id: root.id,
        body,
        external_delivery_id: receipt.externalDeliveryId,
        delivered_at: receipt.deliveredAt,
        attempted_at: attemptedAt.toISOString(),
      });
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
  ): Promise<{ message: MessageRow; inserted: boolean }> {
    if (this.serverManaged) {
      const result = await this.applyServerWrite<{
        message: unknown;
        inserted: boolean;
      }>("create_followup", {
        root_id: root.id,
        body,
        request_id: requestId,
        at: at.toISOString(),
      });
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
  ): Promise<MessageRow> {
    if (this.serverManaged) {
      const data = await this.applyServerWrite<unknown>("complete_followup", {
        message_id: messageId,
        external_delivery_id: receipt.externalDeliveryId,
        delivered_at: receipt.deliveredAt,
        attempted_at: attemptedAt.toISOString(),
      });
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
}
