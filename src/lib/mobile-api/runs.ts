import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { itemLabel } from "@/lib/ui/item-label";
import { mobileRunSchema, type MobileRun } from "./contract";

export interface MobileRunRequest {
  runId: string;
  userId: string;
  bearerToken: string;
}

export interface MobileRunMutationRequest extends MobileRunRequest {
  idempotencyKey: string;
}

/** Tenant-scoped adapter over the canonical #161 durable-run operations. */
export interface MobileRunOperations {
  get(input: MobileRunRequest): Promise<MobileRun | null>;
  retry(input: MobileRunMutationRequest): Promise<MobileRun>;
  cancel(input: MobileRunMutationRequest): Promise<MobileRun>;
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
  readRun(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
  readItem(itemId: string): PromiseLike<MobileRunDataResult<unknown>>;
  readReservation(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
  retryRun(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
  cancelRun(runId: string): PromiseLike<MobileRunDataResult<unknown>>;
}

export class MobileRunNotFoundError extends Error {}
export class MobileRunConflictError extends Error {}
export class MobileRunUnavailableError extends Error {}

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

const reservationRowSchema = z
  .object({ state: z.enum(["reserved", "settled", "restored"]) })
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

  const [rawItemResult, rawReservationResult] = await Promise.all([
    client.readItem(run.item_id),
    client.readReservation(run.id),
  ]);
  const rawItem = requireData("run item", rawItemResult);
  if (!rawItem) throw new MobileRunUnavailableError("Run item was unavailable");
  const item = itemRowSchema.parse(rawItem);
  if (item.id !== run.item_id || item.user_id !== userId) {
    throw new MobileRunUnavailableError("Run item crossed the verified tenant boundary");
  }
  const rawReservation = requireData("run allowance", rawReservationResult);
  const allowance = rawReservation
    ? reservationRowSchema.parse(rawReservation).state
    : "unchanged";
  const expired = run.retention_cleaned_at !== null;
  const terminalOutcome = ["succeeded", "failed", "canceled"].includes(run.status)
    ? run.status as "succeeded" | "failed" | "canceled"
    : null;
  const canRetry = !expired
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
    safeFailure: run.safe_failure_message
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
  if (error.code === "55000" || error.code === "23514") {
    throw new MobileRunConflictError();
  }
  throw new MobileRunUnavailableError("Durable-run mutation failed");
}

export function createMobileRunOperations(
  clientForBearer: (bearerToken: string) => MobileRunDataClient | Promise<MobileRunDataClient>,
): MobileRunOperations {
  return {
    async get(rawInput) {
      const input = requestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      return readCanonicalRun(client, input.runId, input.userId);
    },

    async retry(rawInput) {
      const input = mutationRequestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      const result = await client.retryRun(input.runId);
      if (result.error) mutationFailure(result.error);
      const run = await readCanonicalRun(client, input.runId, input.userId);
      if (!run) throw new MobileRunNotFoundError();
      return run;
    },

    async cancel(rawInput) {
      const input = mutationRequestSchema.parse(rawInput);
      const client = await clientForBearer(input.bearerToken);
      const result = await client.cancelRun(input.runId);
      if (result.error) mutationFailure(result.error);
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
    readReservation(runId) {
      return client
        .from("ai_item_credit_reservations")
        .select("state")
        .eq("pipeline_run_id", runId)
        .maybeSingle();
    },
    retryRun(runId) {
      return client.rpc("retry_pipeline_run", { p_run_id: runId });
    },
    cancelRun(runId) {
      return client.rpc("cancel_pipeline_run", { p_run_id: runId });
    },
  };
}

export function createConfiguredSupabaseMobileRunOperations(input: {
  supabaseURL: string;
  anonKey: string;
}): MobileRunOperations {
  return createMobileRunOperations((bearerToken) =>
    createSupabaseMobileRunDataClient(
      createClient(input.supabaseURL, input.anonKey, {
        accessToken: async () => bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ),
  );
}
