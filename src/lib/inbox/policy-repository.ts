import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketplaceMessagingAdapter } from "@/lib/marketplace/messaging";
import { getAutoReplyEnabled } from "@/lib/settings/user-settings";
import { buildAuthoritativeMessageGrounding } from "./authoritative-grounding";
import type {
  AutoSendBlockReason,
  MessagePolicyRepository,
} from "./autoreply";
import {
  beginEbayMessageWrite,
  beginScheduledEbayMessageWrite,
  readScheduledEbayMessagePolicy,
} from "./ebay-server-write";
import {
  messagePolicyResultSchema,
  decideMessagePolicy,
  type MessagePolicyAuditRecord,
  type MessagePolicyResult,
} from "./policy";
import type { DraftBuyerReplyResult } from "./reply";
import { messageRowSchema, type MessageRow } from "./types";

interface PolicyDecisionRow {
  id: string;
  message_id: string;
  policy_version: string;
  outcome: string;
  reason_codes: unknown;
  grounding_references: unknown;
  safety_signals: unknown;
  proposed_reply: string | null;
  draft_reply: string;
  draft_model: string;
  delivery_status: string;
  decided_at: string;
  listing_updated_at: string;
  item_updated_at: string;
  marketplace_verified_at: string;
  external_listing_id: string;
}

function auditRecord(row: PolicyDecisionRow): MessagePolicyAuditRecord {
  const policy = messagePolicyResultSchema.parse({
    policyVersion: row.policy_version,
    outcome: row.outcome,
    reasonCodes: row.reason_codes,
    groundingReferences: row.grounding_references,
    signals: row.safety_signals,
    proposedReply: row.proposed_reply,
    authorization: {
      listingUpdatedAt: row.listing_updated_at,
      itemUpdatedAt: row.item_updated_at,
      marketplaceObservedAt: row.marketplace_verified_at,
      externalListingId: row.external_listing_id,
    },
  });
  return {
    id: row.id,
    messageId: row.message_id,
    ...policy,
    draftReply: row.draft_reply,
    draftModel: row.draft_model,
    deliveryStatus: row.delivery_status,
    decidedAt: row.decided_at,
  };
}

/** Tenant-pinned policy persistence for foreground and service-role schedulers. */
export class SupabaseMessagePolicyRepository implements MessagePolicyRepository {
  private writeGeneration: Promise<string> | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
    private readonly marketplace: MarketplaceMessagingAdapter,
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

  async getEnabled(): Promise<boolean> {
    if (this.writeTarget.scheduled) {
      return readScheduledEbayMessagePolicy<boolean>(
        this.writeTarget.client,
        this.userId,
        "preference",
      );
    }
    return getAutoReplyEnabled(this.supabase, this.userId);
  }

  async loadGrounding(message: MessageRow) {
    if (!message.listing_id || !message.item_id) {
      throw new Error("Imported buyer question is missing listing grounding");
    }
    let listing: unknown;
    let item: unknown;
    if (this.writeTarget.scheduled) {
      const data = await readScheduledEbayMessagePolicy<{
        listing: unknown;
        item: unknown;
      }>(this.writeTarget.client, this.userId, "grounding", {
        message_id: message.id,
      });
      listing = data?.listing;
      item = data?.item;
    } else {
      const [listingResult, itemResult] = await Promise.all([
        this.supabase
          .from("listings")
          .select(
            "id,item_id,status,ebay_status,ebay_listing_id,copy,listed_price,last_priced_at,updated_at",
          )
          .eq("user_id", this.userId)
          .eq("id", message.listing_id)
          .maybeSingle(),
        this.supabase
          .from("items")
          .select("id,condition,attributes,updated_at")
          .eq("user_id", this.userId)
          .eq("id", message.item_id)
          .maybeSingle(),
      ]);
      if (listingResult.error || itemResult.error) {
        throw new Error(
          `Failed to load authoritative reply grounding: ${listingResult.error?.message ?? itemResult.error?.message}`,
        );
      }
      listing = listingResult.data;
      item = itemResult.data;
    }
    if (!listing || !item) {
      throw new Error("Authoritative listing grounding was not found");
    }
    let marketplace = null;
    if (message.external_listing_id) {
      try {
        marketplace = await this.marketplace.fetchListingSnapshot(
          message.external_listing_id,
        );
      } catch {
        marketplace = null;
      }
    }
    return buildAuthoritativeMessageGrounding({
      listing: listing as Parameters<typeof buildAuthoritativeMessageGrounding>[0]["listing"],
      item: item as Parameters<typeof buildAuthoritativeMessageGrounding>[0]["item"],
      marketplace,
    });
  }

  async recordDecision(
    message: MessageRow,
    result: MessagePolicyResult,
    draft: DraftBuyerReplyResult,
  ): Promise<{ inserted: boolean; decision: MessagePolicyAuditRecord }> {
    const generation = await this.getWriteGeneration();
    const args = {
      p_message_id: message.id,
      p_payload: {
        policy_version: result.policyVersion,
        outcome: result.outcome,
        reason_codes: result.reasonCodes,
        grounding_references: result.groundingReferences,
        safety_signals: result.signals,
        proposed_reply: result.proposedReply,
        draft_reply: draft.reply,
        draft_model: draft.model,
        listing_updated_at: result.authorization.listingUpdatedAt,
        item_updated_at: result.authorization.itemUpdatedAt,
        marketplace_verified_at: result.authorization.marketplaceObservedAt,
        external_listing_id: result.authorization.externalListingId,
      },
      p_generation: generation,
    };
    const call = this.writeTarget.scheduled
      ? this.writeTarget.client.rpc(
          "record_scheduled_ebay_message_policy_decision",
          { p_user_id: this.userId, ...args },
        )
      : this.writeTarget.client.rpc("record_ebay_message_policy_decision", args);
    const { data, error } = await call;
    if (error) {
      throw new Error(`Failed to persist message policy decision: ${error.message}`);
    }
    const parsed = data as { inserted?: unknown; decision?: unknown };
    if (typeof parsed?.inserted !== "boolean" || !parsed.decision) {
      throw new Error("Failed to persist message policy decision: invalid result");
    }
    return {
      inserted: parsed.inserted,
      decision: auditRecord(parsed.decision as PolicyDecisionRow),
    };
  }

  async listPendingAutoSend(policyVersion: string) {
    if (this.writeTarget.scheduled) {
      return readScheduledEbayMessagePolicy<Array<{ messageId: string }>>(
        this.writeTarget.client,
        this.userId,
        "pending_auto_send",
        { policy_version: policyVersion },
      );
    }
    const { data, error } = await this.supabase
      .from("message_policy_decisions")
      .select("message_id")
      .eq("user_id", this.userId)
      .eq("policy_version", policyVersion)
      .eq("outcome", "auto_send")
      .eq("delivery_status", "not_attempted")
      .order("decided_at", { ascending: true });
    if (error) {
      throw new Error(`Failed to read pending automatic replies: ${error.message}`);
    }
    return (data ?? []).map((row) => ({ messageId: row.message_id as string }));
  }

  async revalidatePendingAutoSend(
    messageId: string,
  ): ReturnType<MessagePolicyRepository["revalidatePendingAutoSend"]> {
    if (!(await this.getEnabled())) {
      return { authorized: false, reason: "authorization_changed" };
    }
    let payload: { message: unknown; decision: unknown } | null;
    if (this.writeTarget.scheduled) {
      payload = await readScheduledEbayMessagePolicy<{
        message: unknown;
        decision: unknown;
      } | null>(this.writeTarget.client, this.userId, "pending_auto_send_candidate", {
        message_id: messageId,
      });
    } else {
      const [
        { data: message, error: messageError },
        { data: decision, error: decisionError },
      ] = await Promise.all([
          this.supabase
            .from("messages")
            .select("*")
            .eq("user_id", this.userId)
            .eq("id", messageId)
            .maybeSingle(),
          this.supabase
            .from("message_policy_decisions")
            .select("*")
            .eq("user_id", this.userId)
            .eq("message_id", messageId)
            .maybeSingle(),
        ]);
      if (messageError || decisionError) {
        throw new Error(
          `Failed to revalidate automatic reply: ${messageError?.message ?? decisionError?.message}`,
        );
      }
      payload = message && decision ? { message, decision } : null;
    }
    if (!payload) {
      return { authorized: false, reason: "authorization_changed" };
    }
    const message = messageRowSchema.parse(payload.message);
    const decision = auditRecord(payload.decision as PolicyDecisionRow);
    if (
      message.status !== "drafted" ||
      decision.outcome !== "auto_send" ||
      decision.deliveryStatus !== "not_attempted"
    ) {
      return { authorized: false, reason: "authorization_changed" };
    }
    const questionCreatedAt = new Date(
      message.external_created_at ?? message.created_at,
    );
    if (
      !message.external_message_id ||
      !message.external_listing_id ||
      !Number.isFinite(questionCreatedAt.getTime())
    ) {
      return { authorized: false, reason: "question_not_unanswered" };
    }
    const grounding = await this.loadGrounding(message);
    const current = decideMessagePolicy({
      enabled: true,
      question: message.body,
      grounding,
    });
    const authorized =
      current.outcome === "auto_send" &&
      current.proposedReply === decision.proposedReply &&
      JSON.stringify(current.groundingReferences) ===
        JSON.stringify(decision.groundingReferences) &&
      current.authorization.listingUpdatedAt ===
        decision.authorization.listingUpdatedAt &&
      current.authorization.itemUpdatedAt ===
        decision.authorization.itemUpdatedAt &&
      current.authorization.externalListingId ===
        decision.authorization.externalListingId;
    if (!authorized) {
      return { authorized: false, reason: "authorization_changed" };
    }
    const questionStatus = await this.marketplace.fetchUnansweredQuestions({
      from: questionCreatedAt,
      to: new Date(),
    });
    const stillUnanswered = questionStatus.questions.some(
      (question) =>
        question.externalMessageId === message.external_message_id &&
        question.externalListingId === message.external_listing_id,
    );
    if (
      questionStatus.answeredExternalMessageIds.includes(
        message.external_message_id,
      ) ||
      !stillUnanswered
    ) {
      return { authorized: false, reason: "question_not_unanswered" };
    }
    return {
      authorized: true,
      marketplaceObservedAt: current.authorization.marketplaceObservedAt,
      questionObservedAt: new Date().toISOString(),
    };
  }

  async blockPendingAutoSend(
    messageId: string,
    reason: AutoSendBlockReason,
  ): Promise<void> {
    const generation = await this.getWriteGeneration();
    const args = {
      p_message_id: messageId,
      p_reason: reason,
      p_generation: generation,
    };
    const call = this.writeTarget.scheduled
      ? this.writeTarget.client.rpc(
          "block_scheduled_ebay_message_policy_delivery",
          { p_user_id: this.userId, ...args },
        )
      : this.writeTarget.client.rpc(
          "block_ebay_message_policy_delivery",
          args,
        );
    const { error } = await call;
    if (error) {
      throw new Error(`Failed to block automatic reply: ${error.message}`);
    }
  }
}
