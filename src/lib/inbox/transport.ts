import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MarketplaceDeliveryFailureKind,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
} from "@/lib/marketplace/messaging";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import { messageRowSchema, type MessageRow } from "./types";

const PG_UNIQUE_VIOLATION = "23505";
const DELIVERY_LEASE_MS = 5 * 60_000;

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
  canonicalDelivered(messageId: string): Promise<MessageRow | null>;
  claimCanonical(
    root: MessageRow,
    body: string,
    at: Date,
    retry: boolean,
  ): Promise<boolean>;
  failCanonical(
    messageId: string,
    kind: MarketplaceDeliveryFailureKind,
  ): Promise<void>;
  completeCanonical(
    root: MessageRow,
    body: string,
    receipt: MarketplaceDeliveryReceipt,
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
  ): Promise<void>;
  completeFollowUp(
    messageId: string,
    receipt: MarketplaceDeliveryReceipt,
  ): Promise<MessageRow>;
}

export interface SendCanonicalInput {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  messageId: string;
  body?: string;
  retry?: boolean;
  now?: () => Date;
}

export async function sendCanonicalReply(
  input: SendCanonicalInput,
): Promise<MessageRow> {
  const root = await input.repository.loadConversationRoot(input.messageId);
  if (!root || root.direction !== "inbound") {
    throw new MessageDeliveryConflictError("Buyer question not found");
  }
  const alreadyDelivered = await input.repository.canonicalDelivered(root.id);
  if (alreadyDelivered) return alreadyDelivered;
  const body = (input.body ?? root.draft_reply ?? "").trim();
  if (!body) throw new Error("A non-empty approved reply is required");

  const at = input.now?.() ?? new Date();
  const claimed = await input.repository.claimCanonical(
    root,
    body,
    at,
    input.retry === true,
  );
  if (!claimed) throw new MessageDeliveryConflictError();

  let receipt: MarketplaceDeliveryReceipt;
  try {
    receipt = await input.adapter.replyToQuestion(
      deliveryInput(root, body, root.id),
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await input.repository.failCanonical(root.id, kind);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }

  try {
    return await input.repository.completeCanonical(root, body, receipt);
  } catch (error) {
    // eBay acknowledged delivery but local persistence did not complete. Keep
    // the question visibly ambiguous; a replay first checks for an outbound row.
    await input.repository.failCanonical(root.id, "ambiguous").catch(() => undefined);
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
  if (!root || !(await input.repository.canonicalDelivered(root.id))) {
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
  return deliverFollowUp(input.repository, input.adapter, root, intent.message);
}

export async function retryFollowUpDelivery(input: {
  repository: DeliveryRepository;
  adapter: MarketplaceMessagingAdapter;
  messageId: string;
  now?: () => Date;
}): Promise<MessageRow> {
  const message = await input.repository.loadFollowUp(input.messageId);
  if (!message || message.reply_kind !== "followup" || !message.reply_to) {
    throw new MessageDeliveryConflictError("Follow-up message not found");
  }
  if (message.delivery_status === "delivered") return message;
  const root = await input.repository.loadConversationRoot(message.reply_to);
  if (!root) throw new MessageDeliveryConflictError("Conversation not found");
  const claimed = await input.repository.claimFollowUp(
    message,
    input.now?.() ?? new Date(),
  );
  if (!claimed) throw new MessageDeliveryConflictError();
  return deliverFollowUp(input.repository, input.adapter, root, message);
}

async function deliverFollowUp(
  repository: DeliveryRepository,
  adapter: MarketplaceMessagingAdapter,
  root: MessageRow,
  message: MessageRow,
): Promise<MessageRow> {
  let receipt: MarketplaceDeliveryReceipt;
  try {
    receipt = await adapter.sendFollowUp(
      deliveryInput(root, message.body, message.delivery_request_id ?? message.id),
    );
  } catch (error) {
    const kind = deliveryFailureKind(error);
    await repository.failFollowUp(message.id, kind);
    throw new MessageDeliveryAttemptError(kind, undefined, { cause: error });
  }
  try {
    return await repository.completeFollowUp(message.id, receipt);
  } catch (error) {
    await repository.failFollowUp(message.id, "ambiguous").catch(() => undefined);
    throw new MessageDeliveryAttemptError("ambiguous", undefined, {
      cause: error,
    });
  }
}

function deliveryInput(root: MessageRow, body: string, idempotencyKey: string) {
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
    externalParentId: parent,
    externalConversationId: conversation,
    externalListingId: listing,
    externalBuyerId: buyer,
    body,
    idempotencyKey,
  };
}

function deliveryFailureKind(error: unknown): MarketplaceDeliveryFailureKind {
  return error instanceof MarketplaceDeliveryError ? error.kind : "failed";
}

/** Supabase implementation; every statement is explicitly pinned to userId. */
export class SupabaseDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
  ) {}

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

  async canonicalDelivered(messageId: string): Promise<MessageRow | null> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("reply_to", messageId)
      .eq("direction", "outbound")
      .or("reply_kind.is.null,reply_kind.eq.reply")
      .maybeSingle();
    if (error) throw new Error(`Failed to read canonical reply: ${error.message}`);
    return data ? messageRowSchema.parse(data) : null;
  }

  async claimCanonical(
    root: MessageRow,
    body: string,
    at: Date,
    retry: boolean,
  ): Promise<boolean> {
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
  ): Promise<void> {
    const { error } = await this.supabase
      .from("messages")
      .update({ delivery_status: kind, delivery_error: kind, sent_at: null })
      .eq("user_id", this.userId)
      .eq("id", messageId)
      .eq("delivery_status", "sending");
    if (error) throw new Error(`Failed to persist reply failure: ${error.message}`);
  }

  async completeCanonical(
    root: MessageRow,
    body: string,
    receipt: MarketplaceDeliveryReceipt,
  ): Promise<MessageRow> {
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
      const existing = await this.canonicalDelivered(root.id);
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
      .eq("id", root.id);
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
  ): Promise<void> {
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
      .eq("delivery_status", "sending");
    if (error) throw new Error(`Failed to persist follow-up failure: ${error.message}`);
  }

  async completeFollowUp(
    messageId: string,
    receipt: MarketplaceDeliveryReceipt,
  ): Promise<MessageRow> {
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
      .select("*")
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to finalize follow-up: ${error?.message ?? "claim lost"}`);
    }
    return messageRowSchema.parse(data);
  }
}
