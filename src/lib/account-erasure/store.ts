import { z } from "zod";
import {
  accountErasureAttentionReasonSchema,
  accountErasureDeferralSchema,
  accountErasureRetainedRecordSchema,
  accountErasureStateSchema,
  accountErasureStatusSchema,
  type AccountErasureStore,
} from "./service";

type AccountErasureRpcName =
  | "begin_account_erasure"
  | "confirm_account_erasure_storage_absence"
  | "advance_account_erasure"
  | "record_account_erasure_posthog_person_uuid"
  | "finalize_account_erasure";

interface AccountErasureRpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

export interface AccountErasureRpcClient {
  rpc(
    functionName: AccountErasureRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<AccountErasureRpcResult>;
}

export class AccountErasureIdempotencyConflictError extends Error {
  constructor() {
    super("The Idempotency-Key is already bound to another account erasure.");
    this.name = "AccountErasureIdempotencyConflictError";
  }
}

const rpcStateSchema = z.object({
  generation_id: z.string().uuid(),
  status: accountErasureStatusSchema,
  retained_records: z.array(accountErasureRetainedRecordSchema),
  deferrals: z.array(accountErasureDeferralSchema),
  attention_reasons: z.array(accountErasureAttentionReasonSchema),
  identity: z.object({
    clerk_user_id: z.string().min(1),
    revenuecat_app_user_ids: z.array(z.string().min(1)),
    posthog_person_uuid: z.string().uuid().nullable().default(null),
  }).strict().nullable(),
  storage_objects: z.array(z.object({
    bucket_id: z.enum(["photos", "message-photos"]),
    object_name: z.string().min(1).max(1_024),
  }).strict()),
}).strict().transform((state) => accountErasureStateSchema.parse({
  generationId: state.generation_id,
  status: state.status,
  retainedRecords: state.retained_records,
  deferrals: state.deferrals,
  attentionReasons: state.attention_reasons,
  identity: state.identity === null ? null : {
    clerkUserId: state.identity.clerk_user_id,
    revenueCatAppUserIds: state.identity.revenuecat_app_user_ids,
    postHogPersonUUID: state.identity.posthog_person_uuid,
  },
  storageObjects: state.storage_objects.map((object) => ({
    bucketId: object.bucket_id,
    objectName: object.object_name,
  })),
}));

function rpcData(operation: string, result: AccountErasureRpcResult): unknown {
  if (result.error) {
    if (
      result.error.code === "23505"
      || result.error.message === "Account erasure Idempotency-Key is already bound"
    ) {
      throw new AccountErasureIdempotencyConflictError();
    }
    throw new Error(`Account erasure ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

/** Fixed service-role RPC capability; it provides no generic table access. */
export function createSupabaseAccountErasureStore(
  client: AccountErasureRpcClient,
): AccountErasureStore {
  return {
    async begin(input) {
      const result = await client.rpc("begin_account_erasure", {
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_user_id: z.string().min(1).max(255).parse(input.userId),
      });
      return rpcStateSchema.parse(rpcData("start", result));
    },

    async confirmStorageAbsence(input) {
      const result = await client.rpc("confirm_account_erasure_storage_absence", {
        p_bucket_id: z.enum(["photos", "message-photos"]).parse(input.bucketId),
        p_generation_id: z.string().uuid().parse(input.generationId),
        p_object_name: z.string().min(1).max(1_024).parse(input.objectName),
      });
      return z.boolean().parse(rpcData("Storage confirmation", result));
    },

    async advance(input) {
      const result = await client.rpc("advance_account_erasure", {
        p_generation_id: z.string().uuid().parse(input.generationId),
      });
      return rpcStateSchema.parse(rpcData("advancement", result));
    },

    async recordPostHogPersonUUID(input) {
      const result = await client.rpc("record_account_erasure_posthog_person_uuid", {
        p_generation_id: z.string().uuid().parse(input.generationId),
        p_person_uuid: z.string().uuid().parse(input.personUUID),
      });
      rpcData("PostHog person target recording", result);
    },

    async finalize(input) {
      const result = await client.rpc("finalize_account_erasure", {
        p_attention_reasons: z
          .array(accountErasureAttentionReasonSchema)
          .parse(input.attentionReasons),
        p_clerk_identity_absent: z.boolean().parse(input.clerkIdentityAbsent),
        p_generation_id: z.string().uuid().parse(input.generationId),
        p_posthog_person_and_events_deletion_confirmed: z
          .boolean()
          .parse(input.postHogPersonAndEventsDeletionConfirmed),
        p_revenuecat_customer_absent: z
          .boolean()
          .parse(input.revenueCatCustomerAbsent),
      });
      return rpcStateSchema.parse(rpcData("completion", result));
    },
  };
}
