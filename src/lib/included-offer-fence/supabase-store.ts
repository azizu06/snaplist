import { z } from "zod";
import { INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION } from "./contract";
import {
  includedOfferQueueEnvelopeSchema,
  type IncludedOfferClaim,
  type IncludedOfferClaimStore,
  type IncludedOfferQueueEnvelope,
  type IncludedOfferQueueMessage,
  type IncludedOfferRedemptionQueue,
  type IncludedOfferSupportOverride,
} from "./store";

type IncludedOfferRpcName =
  | "begin_included_offer_claim"
  | "find_included_offer_claim"
  | "find_included_offer_claim_by_key"
  | "transition_included_offer_claim"
  | "enqueue_included_offer_claim"
  | "claim_included_offer_message"
  | "ack_included_offer_message"
  | "defer_included_offer_message"
  | "acquire_included_offer_writer_lease"
  | "release_included_offer_writer_lease"
  | "has_open_included_offer_rendezvous"
  | "expire_stale_included_offer_rendezvous"
  | "holds_included_offer_writer_lease"
  | "find_active_included_offer_override"
  | "consume_included_offer_override";

interface IncludedOfferRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Deliberately narrower than `SupabaseClient`. The redemption authority can call
 * only these fixed RPC names: it has no `.from()` escape hatch into tenant
 * domain tables, so worker authority stays derived from the stored claim.
 */
export interface IncludedOfferRpcClient {
  rpc(
    functionName: IncludedOfferRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<IncludedOfferRpcResult>;
}

const timestamp = z.string().min(1);

/**
 * Mirrors `private.included_offer_claim_json`. Note what is absent: there is no
 * device-token column to project, because none is ever stored.
 */
const claimRowSchema = z
  .object({
    app_attest_key_id: z.string().min(1),
    apple_phase: z.enum(["query", "update"]).nullable(),
    attempt_count: z.number().int().min(0),
    claim_id: z.string().uuid(),
    consumed_at: timestamp.nullable(),
    created_at: timestamp,
    idempotency_key: z.string().min(1),
    queue_message_id: z.union([z.string(), z.number()]).nullable(),
    state: z.enum([
      "queued",
      "awaiting_device_token",
      "apple_pending",
      "reconcile_required",
      "reserved",
      "denied_device_consumed",
      "denied_apple_unavailable",
    ]),
    token_deadline_at: timestamp.nullable(),
    updated_at: timestamp,
    user_id: z.string().min(1),
  })
  .strict();

const overrideRowSchema = z
  .object({
    claim_id: z.string().uuid().nullable(),
    consumed_at: timestamp.nullable(),
    granted_at: timestamp,
    granted_by: z.string().min(1),
    override_id: z.string().uuid(),
    reason: z.string().min(1),
    user_id: z.string().min(1),
  })
  .strict();

const queueRowSchema = z
  .object({
    envelope: z.unknown(),
    message_id: z.union([z.string(), z.number(), z.bigint()]),
    read_count: z.coerce.number().int().min(1),
  })
  .strict();

function failed(operation: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Included-offer ${operation} failed: ${error.message}`);
  }
}

function toClaim(row: z.infer<typeof claimRowSchema>): IncludedOfferClaim {
  return {
    appAttestKeyId: row.app_attest_key_id,
    applePhase: row.apple_phase,
    attemptCount: row.attempt_count,
    claimId: row.claim_id,
    consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at),
    createdAt: new Date(row.created_at),
    idempotencyKey: row.idempotency_key,
    queueMessageId:
      row.queue_message_id === null ? null : String(row.queue_message_id),
    state: row.state,
    tokenDeadlineAt:
      row.token_deadline_at === null ? null : new Date(row.token_deadline_at),
    updatedAt: new Date(row.updated_at),
    userId: row.user_id,
  };
}

function toOverride(
  row: z.infer<typeof overrideRowSchema>,
): IncludedOfferSupportOverride {
  return {
    claimId: row.claim_id,
    consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at),
    grantedAt: new Date(row.granted_at),
    grantedBy: row.granted_by,
    overrideId: row.override_id,
    reason: row.reason,
    userId: row.user_id,
  };
}

function optionalClaim(data: unknown): IncludedOfferClaim | null {
  if (data === null || data === undefined) return null;
  return toClaim(claimRowSchema.parse(data));
}

export function createSupabaseIncludedOfferClaimStore(
  client: IncludedOfferRpcClient,
): IncludedOfferClaimStore {
  return {
    async createClaim(input) {
      const { data, error } = await client.rpc("begin_included_offer_claim", {
        p_app_attest_key_id: input.appAttestKeyId,
        p_claim_id: input.claimId,
        p_idempotency_key: input.idempotencyKey,
        p_state: input.state,
        p_user_id: input.userId,
      });
      failed("claim creation", error);
      return toClaim(claimRowSchema.parse(data));
    },

    async findClaimByIdempotencyKey(input) {
      const { data, error } = await client.rpc(
        "find_included_offer_claim_by_key",
        { p_idempotency_key: input.idempotencyKey, p_user_id: input.userId },
      );
      failed("claim lookup", error);
      return optionalClaim(data);
    },

    async findClaimById(input) {
      const { data, error } = await client.rpc("find_included_offer_claim", {
        p_claim_id: input.claimId,
        // Omitted for the worker's run-scoped read; supplied for caller-facing
        // reads so a claim id alone never discloses another tenant's state.
        p_user_id: input.userId ?? null,
      });
      failed("claim read", error);
      return optionalClaim(data);
    },

    async transitionClaim(input) {
      const { data, error } = await client.rpc(
        "transition_included_offer_claim",
        {
          p_apple_phase: input.applePhase ?? null,
          p_attempt_count: input.attemptCount ?? null,
          p_claim_id: input.claimId,
          p_from: [...input.from],
          p_set_apple_phase: input.applePhase !== undefined,
          p_set_token_deadline: input.tokenDeadlineAt !== undefined,
          p_to: input.to,
          p_token_deadline_at: input.tokenDeadlineAt?.toISOString() ?? null,
        },
      );
      failed("claim transition", error);
      return optionalClaim(data);
    },

    async recordQueueMessage() {
      // `enqueue_included_offer_claim` binds the message to the claim inside the
      // same transaction that sends it, so there is no second write to make and
      // no window where a claim is queued without its message id.
    },

    async findActiveSupportOverride(input) {
      const { data, error } = await client.rpc(
        "find_active_included_offer_override",
        { p_user_id: input.userId },
      );
      failed("override lookup", error);
      if (data === null || data === undefined) return null;
      return toOverride(overrideRowSchema.parse(data));
    },

    async consumeSupportOverride(input) {
      const { data, error } = await client.rpc(
        "consume_included_offer_override",
        { p_claim_id: input.claimId, p_override_id: input.overrideId },
      );
      failed("override consumption", error);
      return z.boolean().parse(data);
    },

    async hasOpenRendezvous(input) {
      const { data, error } = await client.rpc(
        "has_open_included_offer_rendezvous",
        { p_except_claim_id: input.exceptClaimId },
      );
      failed("open rendezvous lookup", error);
      return z.boolean().parse(data);
    },

    async expireStaleRendezvous(input) {
      const { data, error } = await client.rpc(
        "expire_stale_included_offer_rendezvous",
        { p_older_than: input.olderThan.toISOString() },
      );
      failed("stale rendezvous expiry", error);
      return z.array(z.string().uuid()).parse(data ?? []);
    },

    async holdsWriterLease(input) {
      const { data, error } = await client.rpc(
        "holds_included_offer_writer_lease",
        { p_claim_id: input.claimId },
      );
      failed("writer lease continuity check", error);
      return z.boolean().parse(data);
    },

    async acquireWriterLease(input) {
      const { data, error } = await client.rpc(
        "acquire_included_offer_writer_lease",
        {
          p_claim_id: input.claimId,
          p_lease_seconds: Math.max(1, Math.ceil(input.leaseMs / 1000)),
        },
      );
      failed("writer lease acquisition", error);
      return z.boolean().parse(data);
    },

    async releaseWriterLease(input) {
      const { error } = await client.rpc(
        "release_included_offer_writer_lease",
        { p_claim_id: input.claimId },
      );
      failed("writer lease release", error);
    },
  };
}

export function createSupabaseIncludedOfferRedemptionQueue(
  client: IncludedOfferRpcClient,
): IncludedOfferRedemptionQueue {
  return {
    async enqueue(envelope: IncludedOfferQueueEnvelope): Promise<string> {
      const parsed = includedOfferQueueEnvelopeSchema.parse(envelope);
      const { data, error } = await client.rpc("enqueue_included_offer_claim", {
        p_claim_id: parsed.claim_id,
        p_schema_version: INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
      });
      failed("enqueue", error);
      return String(z.union([z.string(), z.number()]).parse(data));
    },

    async claimHead(input): Promise<IncludedOfferQueueMessage | null> {
      const { data, error } = await client.rpc("claim_included_offer_message", {
        p_visibility_timeout_seconds: input.visibilityTimeoutSeconds,
      });
      failed("queue claim", error);
      const rows = z.array(queueRowSchema).parse(data ?? []);
      if (rows.length === 0) return null;
      return {
        envelope: includedOfferQueueEnvelopeSchema.parse(rows[0].envelope),
        messageId: String(rows[0].message_id),
        readCount: rows[0].read_count,
      };
    },

    async ack(messageId: string): Promise<boolean> {
      const { data, error } = await client.rpc("ack_included_offer_message", {
        p_message_id: Number(messageId),
      });
      failed("queue ack", error);
      return z.boolean().parse(data);
    },

    async defer(
      messageId: string,
      visibilityTimeoutSeconds: number,
    ): Promise<boolean> {
      const { data, error } = await client.rpc("defer_included_offer_message", {
        p_message_id: Number(messageId),
        p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      });
      failed("queue defer", error);
      return z.boolean().parse(data);
    },
  };
}
