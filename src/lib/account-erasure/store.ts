import { z } from "zod";
import {
  accountErasureBlockerSchema,
  accountErasureStateSchema,
  resolvedAccountErasureBlockerSchema,
  type AccountErasureStore,
} from "./service";

type AccountErasureRpcName =
  | "begin_account_erasure"
  | "confirm_account_erasure_storage_absence"
  | "advance_account_erasure";

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
  status: z.enum(["deleting", "blocked", "complete"]),
  blockers: z.array(accountErasureBlockerSchema),
  storage_objects: z.array(z.object({
    bucket_id: z.enum(["photos", "message-photos"]),
    object_name: z.string().min(1).max(1_024),
  }).strict()),
}).strict().transform((state) => accountErasureStateSchema.parse({
  generationId: state.generation_id,
  status: state.status,
  blockers: state.blockers,
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
        p_resolved_blockers: z
          .array(resolvedAccountErasureBlockerSchema)
          .parse(input.resolvedBlockers),
      });
      return rpcStateSchema.parse(rpcData("advancement", result));
    },
  };
}
