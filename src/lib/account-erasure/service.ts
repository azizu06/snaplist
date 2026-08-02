import { z } from "zod";

/**
 * The seller-facing erasure vocabulary. `deletion_completed_with_retained_records`
 * is a success state, not a partial failure: it says something survived that
 * SnapList does not own and never claimed to delete. Collapsing it into
 * `deletion_completed` would contradict ADR-0012, so nothing here may narrow it.
 */
export const accountErasureStatusSchema = z.enum([
  "deletion_requested",
  "deletion_in_progress",
  "deletion_completed",
  "deletion_completed_with_retained_records",
  "deletion_needs_attention",
]);

export const accountErasureRetainedRecordSchema = z.enum([
  "hosted-transcription-provider-copy",
  "ebay-live-listing",
]);

/** Work that is not finished yet and is not the seller's fault or problem. */
export const accountErasureDeferralSchema = z.enum([
  "private-storage-objects-pending",
  "ebay-provider-authority-pending",
  "guest-claim-in-progress",
  "mixed-tenant-storage-cleanup",
]);

/** Work that needs a person, because a provider would not confirm absence. */
export const accountErasureAttentionReasonSchema = z.enum([
  "clerk-identity-deletion-unverified",
  "revenuecat-customer-deletion-unverified",
  "deferral-window-exceeded",
]);

export const accountErasureStorageObjectSchema = z.object({
  bucketId: z.enum(["photos", "message-photos"]),
  objectName: z.string().min(1).max(1_024),
}).strict();

export const accountErasureIdentitySchema = z.object({
  clerkUserId: z.string().min(1),
  revenueCatAppUserIds: z.array(z.string().min(1)),
  postHogPersonUUID: z.string().uuid().nullable().default(null),
}).strict();

export const accountErasureStateSchema = z.object({
  generationId: z.string().uuid(),
  status: accountErasureStatusSchema,
  retainedRecords: z.array(accountErasureRetainedRecordSchema),
  deferrals: z.array(accountErasureDeferralSchema),
  attentionReasons: z.array(accountErasureAttentionReasonSchema),
  identity: accountErasureIdentitySchema.nullable(),
  storageObjects: z.array(accountErasureStorageObjectSchema),
}).strict();

export type AccountErasureState = z.infer<typeof accountErasureStateSchema>;
export type AccountErasureStatus = z.infer<typeof accountErasureStatusSchema>;
export type AccountErasureStorageObject = z.infer<
  typeof accountErasureStorageObjectSchema
>;
export type AccountErasureAttentionReason = z.infer<
  typeof accountErasureAttentionReasonSchema
>;

const TERMINAL_STATUSES = new Set<AccountErasureStatus>([
  "deletion_completed",
  "deletion_completed_with_retained_records",
]);

export function isTerminalAccountErasureStatus(
  status: AccountErasureStatus,
): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface AccountErasureStore {
  begin(input: { userId: string; idempotencyKey: string }): Promise<AccountErasureState>;
  confirmStorageAbsence(
    input: AccountErasureStorageObject & { generationId: string },
  ): Promise<boolean>;
  advance(input: { generationId: string }): Promise<AccountErasureState>;
  recordPostHogPersonUUID(input: {
    generationId: string;
    personUUID: string;
  }): Promise<void>;
  finalize(input: {
    generationId: string;
    clerkIdentityAbsent: boolean;
    revenueCatCustomerAbsent: boolean;
    postHogPersonAndEventsDeletionConfirmed: boolean;
    attentionReasons: AccountErasureAttentionReason[];
  }): Promise<AccountErasureState>;
}

export interface AccountErasureStorage {
  remove(object: AccountErasureStorageObject): Promise<void>;
}

/**
 * Provider identity deletion. Each method must report absence it actually
 * observed by reading the record back — a provider accepting a delete request is
 * not proof the record is gone, and ADR-0012 will not accept it as one.
 */
export interface AccountErasureIdentity {
  deleteClerkUser(input: { clerkUserId: string }): Promise<{ absent: boolean }>;
  deleteRevenueCatCustomer(
    input: { appUserId: string },
  ): Promise<{ absent: boolean }>;
}

/** Server-only PostHog management API boundary. */
export interface AccountErasureAnalytics {
  resolvePersonUUID(input: { distinctId: string }): Promise<string | null>;
  deletePersonAndEvents(input: {
    personUUID: string;
  }): Promise<{ confirmed: boolean }>;
}

const userIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);

/**
 * The Storage manifest is re-selected by every `advance`, so an upload that
 * raced the fence adds one more pass rather than escaping. This bounds how many
 * passes one request will spend chasing an unusually busy tenant; the caller
 * retries with the same key and picks the same generation back up.
 */
const MAX_STORAGE_PASSES = 8;

/**
 * Executes only what Postgres cannot: private Storage object removal and the
 * provider identity calls. The generation record, mutation fence, tenant row
 * deletion, residue proof, and terminal status all stay database-owned, so an
 * interrupted request resumes instead of restarting.
 */
export async function eraseAccount(
  rawInput: { userId: string; idempotencyKey: string },
  dependencies: {
    store: AccountErasureStore;
    storage: AccountErasureStorage;
    identity: AccountErasureIdentity;
    analytics: AccountErasureAnalytics;
  },
): Promise<AccountErasureState> {
  const userId = userIdSchema.parse(rawInput.userId);
  const idempotencyKey = z.string().uuid().parse(rawInput.idempotencyKey);

  let state = accountErasureStateSchema.parse(
    await dependencies.store.begin({ userId, idempotencyKey }),
  );
  if (isTerminalAccountErasureStatus(state.status)) return state;

  for (let pass = 0; pass < MAX_STORAGE_PASSES; pass += 1) {
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

    state = accountErasureStateSchema.parse(
      await dependencies.store.advance({ generationId: state.generationId }),
    );
    if (isTerminalAccountErasureStatus(state.status)) return state;

    // Only pending Storage is worth another pass in this request; every other
    // deferral is waiting on something this process cannot make happen.
    const onlyStorageIsPending = state.deferrals.length > 0
      && state.deferrals.every((deferral) => deferral === "private-storage-objects-pending");
    if (state.deferrals.length === 0) break;
    if (!onlyStorageIsPending || state.storageObjects.length === 0) return state;
  }

  if (state.deferrals.length > 0 || state.identity === null) return state;

  const attentionReasons: AccountErasureAttentionReason[] = [];

  const postHogPersonUUID = state.identity.postHogPersonUUID
    ?? await dependencies.analytics.resolvePersonUUID({
      distinctId: state.identity.clerkUserId,
    });
  if (postHogPersonUUID !== null) {
    if (state.identity.postHogPersonUUID === null) {
      await dependencies.store.recordPostHogPersonUUID({
        generationId: state.generationId,
        personUUID: postHogPersonUUID,
      });
    }
    const postHogResult = await dependencies.analytics.deletePersonAndEvents({
      personUUID: postHogPersonUUID,
    });
    if (!postHogResult.confirmed) {
      throw new Error("PostHog person and event deletion was not confirmed.");
    }
  }

  const clerkResult = await dependencies.identity.deleteClerkUser({
    clerkUserId: state.identity.clerkUserId,
  });
  if (!clerkResult.absent) {
    attentionReasons.push("clerk-identity-deletion-unverified");
  }

  let revenueCatCustomerAbsent = true;
  for (const appUserId of state.identity.revenueCatAppUserIds) {
    const result = await dependencies.identity.deleteRevenueCatCustomer({ appUserId });
    if (!result.absent) revenueCatCustomerAbsent = false;
  }
  if (!revenueCatCustomerAbsent) {
    attentionReasons.push("revenuecat-customer-deletion-unverified");
  }

  return accountErasureStateSchema.parse(
    await dependencies.store.finalize({
      generationId: state.generationId,
      clerkIdentityAbsent: clerkResult.absent,
      revenueCatCustomerAbsent,
      postHogPersonAndEventsDeletionConfirmed: true,
      attentionReasons,
    }),
  );
}
