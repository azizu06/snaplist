import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { itemLabel } from "@/lib/ui/item-label";
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
    snapshotRevision: z.string().regex(/^[1-9][0-9]*$/u),
    lastMeaningfulUpdateAt: z.string().datetime({ offset: true }),
    runId: z.string().uuid(),
  })
  .strict();

const runHistoryRowSchema = z
  .object({
    run_id: z.string().uuid(),
    last_meaningful_update_at: z.string().datetime({ offset: true }),
    snapshot_revision: z.string().regex(/^[1-9][0-9]*$/u),
  })
  .strict();

function encodeCursor(payload: z.infer<typeof cursorPayloadSchema>): string {
  return btoa(JSON.stringify(cursorPayloadSchema.parse(payload)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(cursor: string): z.infer<typeof cursorPayloadSchema> {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    return cursorPayloadSchema.parse(JSON.parse(atob(base64 + padding)));
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

async function readCanonicalRun(
  client: MobileRunDataClient,
  runId: string,
  userId: string,
): Promise<MobileRun | null> {
  const rawRun = requireData("run detail", await client.readRun(runId));
  if (!rawRun) return null;
  const run = runRowSchema.parse(rawRun);
  if (run.user_id !== userId) {
    throw new MobileRunUnavailableError("Run detail crossed the verified tenant boundary");
  }

  const [rawItemResult, rawProjectionResult] = await Promise.all([
    client.readItem(run.item_id),
    client.readRetryProjection(run.id),
  ]);
  const rawItem = requireData("run item", rawItemResult);
  if (!rawItem) throw new MobileRunUnavailableError("Run item was unavailable");
  const item = itemRowSchema.parse(rawItem);
  if (item.id !== run.item_id || item.user_id !== userId) {
    throw new MobileRunUnavailableError("Run item crossed the verified tenant boundary");
  }
  const rawProjection = requireData("run retry projection", rawProjectionResult);
  if (!rawProjection) {
    throw new MobileRunUnavailableError("Run retry projection was unavailable");
  }
  const retryProjection = retryProjectionRowSchema.parse(rawProjection);
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
      canOpenReview: run.status === "succeeded" && run.listing_id !== null,
      canStartNewCapture: expired && terminalOutcome !== null,
    },
    lastMeaningfulUpdateAt: run.updated_at,
    retentionCleanedAt: run.retention_cleaned_at,
  });
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
): MobileRunOperations & MobileRunHistoryReader {
  return {
    async list(rawInput) {
      const input = historyRequestSchema.parse(rawInput);
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
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
      const runs = await Promise.all(
        pageRows.map((row) => readCanonicalRun(client, row.run_id, input.userId)),
      );
      if (runs.some((run) => run === null)) {
        throw new MobileRunUnavailableError("Run history changed during projection");
      }
      const boundary = rows.length > input.limit ? pageRows.at(-1) : undefined;

      return mobileRunCollectionSchema.parse({
        runs,
        nextCursor: boundary && snapshotRevision
          ? encodeCursor({
              snapshotRevision,
              lastMeaningfulUpdateAt: boundary.last_meaningful_update_at,
              runId: boundary.run_id,
            })
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
}): MobileRunOperations & MobileRunHistoryReader {
  return createMobileRunOperations((bearerToken) =>
    createSupabaseMobileRunDataClient(
      createClient(input.supabaseURL, input.anonKey, {
        accessToken: async () => bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ),
  );
}
