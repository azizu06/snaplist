import { z } from "zod";

export const accountErasureBlockerSchema = z.enum([
  "hosted-transcription-retention",
  "ebay-publish-receipt-obligations",
  "clerk-identity-retention",
  "apple-revenuecat-reference-obligations",
  "external-ebay-authority-pending",
  "guest-claim-active",
  "mixed-storage-cleanup-authority",
]);

export const resolvedAccountErasureBlockerSchema = accountErasureBlockerSchema.extract([
  "hosted-transcription-retention",
  "ebay-publish-receipt-obligations",
  "clerk-identity-retention",
  "apple-revenuecat-reference-obligations",
]);

export const accountErasureStorageObjectSchema = z.object({
  bucketId: z.enum(["photos", "message-photos"]),
  objectName: z.string().min(1).max(1_024),
}).strict();

export const accountErasureStateSchema = z.object({
  generationId: z.string().uuid(),
  status: z.enum(["deleting", "blocked", "complete"]),
  blockers: z.array(accountErasureBlockerSchema),
  storageObjects: z.array(accountErasureStorageObjectSchema),
}).strict();

export type AccountErasureState = z.infer<typeof accountErasureStateSchema>;
export type AccountErasureStorageObject = z.infer<
  typeof accountErasureStorageObjectSchema
>;
export type ResolvedAccountErasureBlocker = z.infer<
  typeof resolvedAccountErasureBlockerSchema
>;

export interface AccountErasureStore {
  begin(input: { userId: string; idempotencyKey: string }): Promise<AccountErasureState>;
  confirmStorageAbsence(
    input: AccountErasureStorageObject & { generationId: string },
  ): Promise<boolean>;
  advance(input: {
    generationId: string;
    resolvedBlockers: ResolvedAccountErasureBlocker[];
  }): Promise<AccountErasureState>;
}

export interface AccountErasureStorage {
  remove(object: AccountErasureStorageObject): Promise<void>;
}

export interface AccountErasureDispositions {
  resolvedBlockers(input: {
    generationId: string;
    userId: string;
  }): Promise<ResolvedAccountErasureBlocker[]>;
}

const userIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);

/**
 * Executes only the non-transactional Storage phase around the database-owned
 * generation, fence, row deletion, and completion proof.
 */
export async function eraseAccount(
  rawInput: { userId: string; idempotencyKey: string },
  dependencies: {
    store: AccountErasureStore;
    storage: AccountErasureStorage;
    dispositions: AccountErasureDispositions;
  },
): Promise<AccountErasureState> {
  const userId = userIdSchema.parse(rawInput.userId);
  const idempotencyKey = z.string().uuid().parse(rawInput.idempotencyKey);
  let state = accountErasureStateSchema.parse(
    await dependencies.store.begin({ userId, idempotencyKey }),
  );

  if (state.status === "complete") return state;

  for (let pass = 0; pass < 8; pass += 1) {
    for (const object of state.storageObjects) {
      await dependencies.storage.remove(object);
      const confirmed = await dependencies.store.confirmStorageAbsence({
        generationId: state.generationId,
        ...object,
      });
      if (!confirmed) {
        throw new Error("Account erasure Storage absence was not confirmed.");
      }
    }

    const resolvedBlockers = z.array(resolvedAccountErasureBlockerSchema).parse(
      await dependencies.dispositions.resolvedBlockers({
        generationId: state.generationId,
        userId,
      }),
    );
    state = accountErasureStateSchema.parse(
      await dependencies.store.advance({
        generationId: state.generationId,
        resolvedBlockers,
      }),
    );
    if (state.status !== "deleting" || state.storageObjects.length === 0) {
      return state;
    }
  }

  throw new Error("Account erasure Storage did not quiesce.");
}
