import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutoReplyEnabled } from "@/lib/settings/user-settings";
import { buildAuthoritativeMessageGrounding } from "./authoritative-grounding";
import type { MessagePolicyRepository } from "./autoreply";
import {
  beginEbayMessageWrite,
  beginScheduledEbayMessageWrite,
  readScheduledEbayMessagePolicy,
} from "./ebay-server-write";
import {
  messagePolicyResultSchema,
  type MessagePolicyAuditRecord,
  type MessagePolicyResult,
} from "./policy";
import type { DraftBuyerReplyResult } from "./reply";
import type { MessageRow } from "./types";

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
}

function auditRecord(row: PolicyDecisionRow): MessagePolicyAuditRecord {
  const policy = messagePolicyResultSchema.parse({
    policyVersion: row.policy_version,
    outcome: row.outcome,
    reasonCodes: row.reason_codes,
    groundingReferences: row.grounding_references,
    signals: row.safety_signals,
    proposedReply: row.proposed_reply,
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
          .select("id,condition,attributes")
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
    return buildAuthoritativeMessageGrounding({
      listing: listing as Parameters<typeof buildAuthoritativeMessageGrounding>[0]["listing"],
      item: item as Parameters<typeof buildAuthoritativeMessageGrounding>[0]["item"],
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
    if (!(await this.getEnabled())) return [];
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
}
