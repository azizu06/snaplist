import { z } from "zod";
import { guestClaimTerminalOutcomeSchema } from "./service";

const base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const encryptedGuestRecoveryArtifactSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    keyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    keyEnvelope: base64Schema,
    nonce: base64Schema,
    tag: base64Schema,
    ciphertext: base64Schema,
  })
  .strict();

export type EncryptedGuestRecoveryArtifact = z.infer<
  typeof encryptedGuestRecoveryArtifactSchema
>;

export const guestRecoveryStorageManifestSchema = z
  .array(
    z
      .object({
        sourcePath: z
          .string()
          .min(3)
          .max(1_024)
          .refine((value) => !value.includes("://") && !/[?#]/.test(value)),
        sha256: sha256Schema,
        byteLength: z.number().int().positive().max(50 * 1_024 * 1_024),
      })
      .strict(),
  )
  .min(1)
  .max(4)
  .superRefine((objects, context) => {
    if (new Set(objects.map((object) => object.sourcePath)).size !== objects.length) {
      context.addIssue({
        code: "custom",
        message: "Guest recovery Storage paths must be unique.",
      });
    }
  });

export type GuestRecoveryStorageManifest = z.infer<
  typeof guestRecoveryStorageManifestSchema
>;

export const guestRecoverableOutcomeSchema = z
  .object({
    outcome: z.literal("recoverable"),
    recoveryId: z.string().uuid(),
    itemId: z.string().uuid(),
    runId: z.string().uuid(),
    draftId: z.string().uuid(),
    usableDraftAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    encryptedArtifact: encryptedGuestRecoveryArtifactSchema,
    purgeLocalRecovery: z.literal(false),
  })
  .strict();

export const guestRecoveryResolutionSchema = z.discriminatedUnion("outcome", [
  guestRecoverableOutcomeSchema,
  ...guestClaimTerminalOutcomeSchema.options,
]);

export type GuestRecoveryResolution = z.infer<
  typeof guestRecoveryResolutionSchema
>;

type GuestRecoveryRpcName =
  | "register_guest_draft_recovery"
  | "recover_guest_draft";

interface GuestRecoveryRpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface GuestRecoveryRpcClient {
  rpc(
    functionName: GuestRecoveryRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<GuestRecoveryRpcResult>;
}

function rpcData(operation: string, result: GuestRecoveryRpcResult): unknown {
  if (result.error) {
    throw new Error(`Guest recovery ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

export interface GuestRecoveryStore {
  register(input: {
    recoveryId: string;
    guestUserId: string;
    pipelineRunId: string;
    recoveryTokenHash: string;
    encryptedArtifact: EncryptedGuestRecoveryArtifact;
    storageManifest: GuestRecoveryStorageManifest;
  }): Promise<GuestRecoveryResolution>;
  recover(input: {
    recoveryId: string;
    guestUserId: string;
    recoveryTokenHash: string;
  }): Promise<GuestRecoveryResolution>;
}

const identitySchema = z.object({
  recoveryId: z.string().uuid(),
  guestUserId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  recoveryTokenHash: sha256Schema,
});

/** Fixed recovery capability for #174/#159 consumers; no generic domain access. */
export function createSupabaseGuestRecoveryStore(
  client: GuestRecoveryRpcClient,
): GuestRecoveryStore {
  return {
    async register(rawInput) {
      const input = identitySchema
        .extend({
          pipelineRunId: z.string().uuid(),
          encryptedArtifact: encryptedGuestRecoveryArtifactSchema,
          storageManifest: guestRecoveryStorageManifestSchema,
        })
        .strict()
        .parse(rawInput);
      const result = await client.rpc("register_guest_draft_recovery", {
        p_encrypted_artifact: input.encryptedArtifact,
        p_guest_user_id: input.guestUserId,
        p_pipeline_run_id: input.pipelineRunId,
        p_recovery_id: input.recoveryId,
        p_recovery_token_hash: input.recoveryTokenHash,
        p_storage_manifest: input.storageManifest,
      });
      return guestRecoveryResolutionSchema.parse(
        rpcData("registration", result),
      );
    },

    async recover(rawInput) {
      const input = identitySchema.strict().parse(rawInput);
      const result = await client.rpc("recover_guest_draft", {
        p_guest_user_id: input.guestUserId,
        p_recovery_id: input.recoveryId,
        p_recovery_token_hash: input.recoveryTokenHash,
      });
      return guestRecoveryResolutionSchema.parse(rpcData("lookup", result));
    },
  };
}
