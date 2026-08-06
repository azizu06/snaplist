import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { itemLabel } from "@/lib/ui/item-label";
import { signPhotoUrlMap } from "@/lib/vision/photos";
import {
  mobileRunCollectionSchema,
  mobileRunSchema,
  type MobileRun,
  type MobileRunCollection,
} from "./contract";

export interface MobileRunRequest {
  runId: string;
  userId: string;
  bearerToken: string;
}

export interface MobileRunMutationRequest extends MobileRunRequest {
  idempotencyKey: string;
}

export interface MobileRunHistoryRequest {
  userId: string;
  bearerToken: string;
  limit: number;
  cursor?: string;
}

/** Tenant-scoped adapter over the canonical #161 durable-run operations. */
export interface MobileRunOperations {
  get(input: MobileRunRequest): Promise<MobileRun | null>;
  retry(input: MobileRunMutationRequest): Promise<MobileRun>;
  cancel(input: MobileRunMutationRequest): Promise<MobileRun>;
}

export interface MobileRunHistoryReader {
  list(input: MobileRunHistoryRequest): Promise<MobileRunCollection>;
}

export interface MobileRunDataError {
  code?: string;
  message: string;
}

interface MobileRunDataResult<T> {
  data: T | null;
  error: MobileRunDataError | null;
}

export interface MobileRunDataClient {
  listRunHistoryPage(input: {
    limit: number;
    snapshotRevision?: string;
    before?: { lastMeaningfulUpdateAt: string; runId: string };
  }): PromiseLike<MobileRunDataResult<unknown[]>>;
  readDeliveryProjections(
    itemIds: string[],
  ): PromiseLike<MobileRunDataResult<unknown[]>>;
  signCoverPhotoUrls(paths: string[]): PromiseLike<Map<string, string>>;
  readRun(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
  readItem(itemId: string): PromiseLike<MobileRunDataResult<unknown>>;
  readRetryProjection(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
  retryRun(
    runId: string,
    idempotencyKey: string,
  ): PromiseLike<MobileRunDataResult<unknown>>;
  cancelRun(
    runId: string,
    idempotencyKey: string,
  ): PromiseLike<MobileRunDataResult<unknown>>;
}

export class MobileRunNotFoundError extends Error {}
export class MobileRunConflictError extends Error {}
export class MobileRunUnavailableError extends Error {}
export class MobileRunInvalidCursorError extends Error {}

const requestSchema = z
  .object({
    runId: z.string().uuid(),
    userId: z.string().min(1),
    bearerToken: z.string().min(1),
  })
  .strict();

const mutationRequestSchema = requestSchema.extend({
  idempotencyKey: z.string().uuid(),
}).strict();

const historyRequestSchema = z
  .object({
    userId: z.string().min(1),
    bearerToken: z.string().min(1),
    limit: z.number().int().min(1).max(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

const cursorPayloadSchema = z
  .object({
    userId: z.string().min(1),
    snapshotRevision: z.string().regex(/^[1-9][0-9]*$/u),
    lastMeaningfulUpdateAt: z.string().datetime({ offset: true }),
    runId: z.string().uuid(),
  })
  .strict();

const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const cursorSignatureContext = "snaplist:mobile-run-history-cursor:v1\0";

function cursorSignature(payload: string, signingSecret: string): Buffer {
  return createHmac("sha256", signingSecret)
    .update(cursorSignatureContext)
    .update(payload)
    .digest();
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!canonicalBase64UrlPattern.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function encodeCursor(
  payload: z.infer<typeof cursorPayloadSchema>,
  signingSecret: string,
): string {
  const encodedPayload = Buffer.from(
    JSON.stringify(cursorPayloadSchema.parse(payload)),
  ).toString("base64url");
  const authenticatedPayload = `v1.${encodedPayload}`;
  const signature = cursorSignature(authenticatedPayload, signingSecret)
    .toString("base64url");
  return `${authenticatedPayload}.${signature}`;
}

function decodeCursor(
  cursor: string,
  signingSecret: string,
): z.infer<typeof cursorPayloadSchema> {
  const [version, encodedPayload, encodedSignature, ...rest] = cursor.split(".");
  const payload = encodedPayload
    ? decodeCanonicalBase64Url(encodedPayload)
    : null;
  const signature = encodedSignature
    ? decodeCanonicalBase64Url(encodedSignature)
    : null;
  const authenticatedPayload = `v1.${encodedPayload ?? ""}`;
  const expectedSignature = cursorSignature(
    authenticatedPayload,
    signingSecret,
  );
  if (
    version !== "v1"
    || rest.length > 0
    || !payload
    || !signature
    || signature.length !== expectedSignature.length
    || !timingSafeEqual(signature, expectedSignature)
  ) {
    throw new MobileRunInvalidCursorError();
  }
  try {
    return cursorPayloadSchema.parse(JSON.parse(payload.toString("utf8")));
  } catch {
    throw new MobileRunInvalidCursorError();
  }
}

const runRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    item_id: z.string().uuid(),
    listing_id: z.string().uuid().nullable(),
    status: z.enum(["queued", "running", "retrying", "succeeded", "failed", "canceled"]),
    stage: z.enum(["queued", "identifying", "pricing", "generating", "persisting", "completed"]),
    schema_version: z.literal(1),
    attempt_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    safe_failure_message: z.string().min(1).max(500).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    enqueued_at: z.string().datetime({ offset: true }).nullable(),
    started_at: z.string().datetime({ offset: true }).nullable(),
    last_attempted_at: z.string().datetime({ offset: true }).nullable(),
    next_attempt_at: z.string().datetime({ offset: true }).nullable(),
    completed_at: z.string().datetime({ offset: true }).nullable(),
    retention_cleaned_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const itemRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    attributes: z.unknown(),
    photos: z.array(z.string()),
  })
  .strict();

const retryProjectionRowSchema = z
  .object({
    effective_allowance: z.enum(["reserved", "settled", "restored", "unchanged"]),
    can_retry: z.boolean(),
  })
  .strict();

const runHistoryRowSchema = z
  .object({
    run_id: z.string().uuid(),
    logical_idempotency_key: z.string().min(1).max(128),
    last_meaningful_update_at: z.string().datetime({ offset: true }),
    snapshot_revision: z.string().regex(/^[1-9][0-9]*$/u),
    run_projection: runRowSchema,
    item_projection: itemRowSchema,
    retry_projection: retryProjectionRowSchema,
  })
  .strict();

const deliveryProjectionRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    item_id: z.string().uuid(),
    platform: z.string().min(1),
    source_review_revision: z.string().uuid().nullable(),
    ebay_listing_id: z.string().min(1).nullable(),
    ebay_status: z.string().nullable(),
  })
  .strict();

type DeliveryProjection = NonNullable<MobileRun["delivery"]>;

function deliveryProjection(
  run: z.infer<typeof runRowSchema>,
  item: z.infer<typeof itemRowSchema>,
  rows: z.infer<typeof deliveryProjectionRowSchema>[],
  userId: string,
  coverPhotoUrl?: string,
): DeliveryProjection | undefined {
  const itemRows = rows.filter((row) => row.item_id === item.id);
  if (itemRows.some((row) => row.user_id !== userId)) {
    throw new MobileRunUnavailableError(
      "Run delivery crossed the verified tenant boundary",
    );
  }
  if (
    run.listing_id
    && itemRows.some((row) =>
      row.id === run.listing_id
      && row.platform === "ebay"
      && row.ebay_status === "published"
      && row.ebay_listing_id !== null
    )
  ) {
    return {
      state: "published_to_ebay",
      ...(coverPhotoUrl ? { coverPhotoUrl } : {}),
    };
  }
  if (
    itemRows.some((row) =>
      ["facebook", "mercari"].includes(row.platform)
      && row.source_review_revision !== null
    )
  ) {
    return {
      state: "export_prepared",
      ...(coverPhotoUrl ? { coverPhotoUrl } : {}),
    };
  }
  return undefined;
}

const mutationRejectionSchema = z
  .object({
    mobileRunOperationError: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

function requireData<T>(
  operation: string,
  result: MobileRunDataResult<T>,
): T | null {
  if (result.error) {
    throw new MobileRunUnavailableError(`${operation} failed`);
  }
  return result.data;
}

function projectCanonicalRun(
  run: z.infer<typeof runRowSchema>,
  item: z.infer<typeof itemRowSchema>,
  retryProjection: z.infer<typeof retryProjectionRowSchema>,
  userId: string,
  delivery?: DeliveryProjection,
): MobileRun {
  if (run.user_id !== userId) {
    throw new MobileRunUnavailableError("Run detail crossed the verified tenant boundary");
  }
  if (item.id !== run.item_id || item.user_id !== userId) {
    throw new MobileRunUnavailableError("Run item crossed the verified tenant boundary");
  }
  const allowance = retryProjection.effective_allowance;
  const expired = run.retention_cleaned_at !== null;
  const terminalOutcome = ["succeeded", "failed", "canceled"].includes(run.status)
    ? run.status as "succeeded" | "failed" | "canceled"
    : null;
  const canRetry = retryProjection.can_retry
    && !expired
    && run.listing_id === null
    && (run.status === "failed" || run.status === "canceled");
  const canCancel = run.listing_id === null
    && (run.status === "queued" || run.status === "running" || run.status === "retrying");

  return mobileRunSchema.parse({
    id: run.id,
    itemId: run.item_id,
    listingId: run.listing_id,
    status: run.status,
    stage: run.stage,
    attemptCount: run.attempt_count,
    maxAttempts: run.max_attempts,
    schemaVersion: run.schema_version,
    timestamps: {
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      enqueuedAt: run.enqueued_at,
      startedAt: run.started_at,
      lastAttemptedAt: run.last_attempted_at,
      nextAttemptAt: run.next_attempt_at,
      completedAt: run.completed_at,
      retentionCleanedAt: run.retention_cleaned_at,
    },
    item: {
      title: itemLabel(item.attributes, item.id),
      photoCount: item.photos.length,
    },
    requiredInput: null,
    terminalOutcome,
    safeFailure: run.status === "failed" && run.safe_failure_message
      ? {
          reason: "This run couldn’t finish",
          detail: run.safe_failure_message,
          retryable: canRetry,
          workPreserved: !expired,
        }
      : null,
    allowance,
    legalActions: {
      canRetry,
      canCancel,
      canOpenReview: false,
      canStartNewCapture: expired && terminalOutcome !== null,
    },
    ...(delivery ? { delivery } : {}),
    lastMeaningfulUpdateAt: run.updated_at,
    retentionCleanedAt: run.retention_cleaned_at,
  });
}

async function readCanonicalRun(
  client: MobileRunDataClient,
  runId: string,
  userId: string,
): Promise<MobileRun | null> {
  const rawRun = requireData("run detail", await client.readRun(runId));
  if (!rawRun) return null;
  const run = runRowSchema.parse(rawRun);
  const [rawItemResult, rawProjectionResult] = await Promise.all([
    client.readItem(run.item_id),
    client.readRetryProjection(run.id),
  ]);
  const rawItem = requireData("run item", rawItemResult);
  if (!rawItem) throw new MobileRunUnavailableError("Run item was unavailable");
  const rawProjection = requireData("run retry projection", rawProjectionResult);
  if (!rawProjection) {
    throw new MobileRunUnavailableError("Run retry projection was unavailable");
  }

  return projectCanonicalRun(
    run,
    itemRowSchema.parse(rawItem),
    retryProjectionRowSchema.parse(rawProjection),
    userId,
  );
}

function mutationFailure(error: MobileRunDataError): never {
  if (error.code === "P0002") throw new MobileRunNotFoundError();
  if (error.code === "P0001" || error.code === "55000" || error.code === "23514") {
    throw new MobileRunConflictError();
  }
  throw new MobileRunUnavailableError("Durable-run mutation failed");
}

function durableMutationFailure(data: unknown): void {
  const rejection = mutationRejectionSchema.safeParse(data);
  if (rejection.success) mutationFailure(rejection.data.mobileRunOperationError);
}

export function createMobileRunOperations(
  clientForBearer: (bearerToken: string) => MobileRunDataClient | Promise<MobileRunDataClient>,
  cursorSigningSecret: string,
): MobileRunOperations & MobileRunHistoryReader {
  const signingSecret = z.string().min(32).parse(cursorSigningSecret);
  return {
    async list(rawInput) {
      const input = historyRequestSchema.parse(rawInput);
      const cursor = input.cursor
        ? decodeCursor(input.cursor, signingSecret)
        : undefined;
      if (cursor && cursor.userId !== input.userId) {
        throw new MobileRunInvalidCursorError();
      }
      const client = await clientForBearer(input.bearerToken);
      const rawRows = requireData(
        "run history",
        await client.listRunHistoryPage({
          limit: input.limit + 1,
          ...(cursor
            ? {
                snapshotRevision: cursor.snapshotRevision,
                before: {
                  lastMeaningfulUpdateAt: cursor.lastMeaningfulUpdateAt,
                  runId: cursor.runId,
                },
              }
            : {}),
        }),
      );
      if (!rawRows) {
        throw new MobileRunUnavailableError("Run history was unavailable");
      }
      const rows = z.array(runHistoryRowSchema).parse(rawRows);
      const pageRows = rows.slice(0, input.limit);
      const snapshotRevision = rows[0]?.snapshot_revision;
      if (
        rows.some((row) => row.snapshot_revision !== snapshotRevision)
        || (cursor && snapshotRevision && snapshotRevision !== cursor.snapshotRevision)
      ) {
        throw new MobileRunUnavailableError("Run history snapshot changed");
      }
      const itemIds = [...new Set(
        pageRows.map((row) => row.item_projection.id),
      )];
      const coverPhotoPaths = [...new Set(
        pageRows.flatMap((row) => row.item_projection.photos.slice(0, 1)),
      )];
      const [rawDeliveryRows, coverPhotoUrls] = pageRows.length === 0
        ? [[], new Map<string, string>()] as const
        : await Promise.all([
            client.readDeliveryProjections(itemIds).then((result) =>
              requireData("run delivery history", result)
            ),
            client.signCoverPhotoUrls(coverPhotoPaths),
          ]);
      if (!rawDeliveryRows) {
        throw new MobileRunUnavailableError(
          "Run delivery history was unavailable",
        );
      }
      const deliveryRows = z.array(deliveryProjectionRowSchema).parse(
        rawDeliveryRows,
      );
      const runs = pageRows.map((row) =>
        projectCanonicalRun(
          row.run_projection,
          row.item_projection,
          row.retry_projection,
          input.userId,
          deliveryProjection(
            row.run_projection,
            row.item_projection,
            deliveryRows,
            input.userId,
            row.item_projection.photos[0]
              ? coverPhotoUrls.get(row.item_projection.photos[0])
              : undefined,
          ),
        )
      );
      const boundary = rows.length > input.limit ? pageRows.at(-1) : undefined;

      return mobileRunCollectionSchema.parse({
        entries: pageRows.map((row, index) => ({
          run: runs[index],
          logicalIdentity: {
            idempotencyKey: row.logical_idempotency_key,
          },
          orderKey: {
            lastMeaningfulUpdateAt: row.last_meaningful_update_at,
            runId: row.run_id,
          },
        })),
        nextCursor: boundary && snapshotRevision
          ? encodeCursor({
              userId: input.userId,
              snapshotRevision,
              lastMeaningfulUpdateAt: boundary.last_meaningful_update_at,
              runId: boundary.run_id,
            }, signingSecret)
          : null,
      });
    },

    async get(rawInput) {
      const input = requestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      return readCanonicalRun(client, input.runId, input.userId);
    },

    async retry(rawInput) {
      const input = mutationRequestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      const result = await client.retryRun(input.runId, input.idempotencyKey);
      if (result.error) mutationFailure(result.error);
      durableMutationFailure(result.data);
      const run = await readCanonicalRun(client, input.runId, input.userId);
      if (!run) throw new MobileRunNotFoundError();
      return run;
    },

    async cancel(rawInput) {
      const input = mutationRequestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      const result = await client.cancelRun(input.runId, input.idempotencyKey);
      if (result.error) mutationFailure(result.error);
      durableMutationFailure(result.data);
      const run = await readCanonicalRun(client, input.runId, input.userId);
      if (!run) throw new MobileRunNotFoundError();
      return run;
    },
  };
}

const MOBILE_RUN_SELECT = [
  "id",
  "user_id",
  "item_id",
  "listing_id",
  "status",
  "stage",
  "schema_version",
  "attempt_count",
  "max_attempts",
  "safe_failure_message",
  "created_at",
  "updated_at",
  "enqueued_at",
  "started_at",
  "last_attempted_at",
  "next_attempt_at",
  "completed_at",
  "retention_cleaned_at",
].join(",");

export function createSupabaseMobileRunDataClient(
  client: SupabaseClient,
): MobileRunDataClient {
  return {
    listRunHistoryPage(input) {
      return client.rpc("list_mobile_run_history_page", {
        p_limit: input.limit,
        p_snapshot_revision: input.snapshotRevision ?? null,
        p_before_updated_at: input.before?.lastMeaningfulUpdateAt ?? null,
        p_before_run_id: input.before?.runId ?? null,
      });
    },
    readDeliveryProjections(itemIds) {
      return client
        .from("listings")
        .select(
          "id,user_id,item_id,platform,source_review_revision,ebay_listing_id,ebay_status",
        )
        .in("item_id", itemIds);
    },
    signCoverPhotoUrls(paths) {
      return signPhotoUrlMap(client, paths);
    },
    readRun(runId) {
      return client
        .from("pipeline_runs")
        .select(MOBILE_RUN_SELECT)
        .eq("id", runId)
        .maybeSingle();
    },
    readItem(itemId) {
      return client
        .from("items")
        .select("id,user_id,attributes,photos")
        .eq("id", itemId)
        .maybeSingle();
    },
    readRetryProjection(runId) {
      return client
        .rpc("get_pipeline_run_retry_projection", { p_run_id: runId })
        .maybeSingle();
    },
    retryRun(runId, idempotencyKey) {
      return client.rpc("apply_mobile_run_operation", {
        p_run_id: runId,
        p_operation: "retry",
        p_idempotency_key: idempotencyKey,
      });
    },
    cancelRun(runId, idempotencyKey) {
      return client.rpc("apply_mobile_run_operation", {
        p_run_id: runId,
        p_operation: "cancel",
        p_idempotency_key: idempotencyKey,
      });
    },
  };
}

export function createConfiguredSupabaseMobileRunOperations(input: {
  supabaseURL: string;
  anonKey: string;
  cursorSigningSecret: string;
}): MobileRunOperations & MobileRunHistoryReader {
  return createMobileRunOperations(
    (bearerToken) =>
      createSupabaseMobileRunDataClient(
        createClient(input.supabaseURL, input.anonKey, {
          accessToken: async () => bearerToken,
          auth: { persistSession: false, autoRefreshToken: false },
        }),
      ),
    input.cursorSigningSecret,
  );
}
