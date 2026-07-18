import type {
  PipelineReplayBatchInput,
  PipelineStageBatchInput,
  PipelineStageBatchResult,
} from "@/lib/pipeline-staging";

const ACCEPTED_PHOTO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export interface PendingUploadEntry {
  idempotencyKey: string;
  source: "single" | "batch";
  autopilotEnabled: boolean;
  costBasis: number | null;
  photos: File[];
}

export interface StageUploadEntriesInput {
  batchId: string;
  userId: string;
  dailyLimit: number;
  perMinuteLimit: number;
  entries: PendingUploadEntry[];
}

export interface UploadStagingDependencies {
  upload(path: string, photo: File): Promise<void>;
  onUploadProgress?(snapshot: UploadProgressSnapshot): void | Promise<void>;
  remove(paths: string[]): Promise<void>;
  findReplay(input: PipelineReplayBatchInput): Promise<PipelineStageBatchResult>;
  stageAndEnqueue(input: PipelineStageBatchInput): Promise<PipelineStageBatchResult>;
  recordCleanupIntent(input: {
    cleanupId: string;
    userId: string;
    batchId: string;
    photoPaths: string[];
  }): Promise<boolean | void>;
  resolveCleanupIntent(cleanupId: string): Promise<boolean | void>;
}

declare const uploadProgressSnapshotType: unique symbol;

export type UploadProgressSnapshot = Readonly<{
  [uploadProgressSnapshotType]: true;
}>;

export interface UploadedPhotoProgressFacts {
  uploadSessionId: string;
  entryIndex: number;
  uploadedPhotoCount: number;
  plannedPhotoCount: number | null;
}

const uploadedPhotoProgress = new WeakMap<object, UploadedPhotoProgressFacts>();

function createUploadProgressSnapshot(
  facts: UploadedPhotoProgressFacts,
): UploadProgressSnapshot {
  const snapshot = Object.freeze({}) as UploadProgressSnapshot;
  uploadedPhotoProgress.set(snapshot, { ...facts });
  return snapshot;
}

/** Producer-owned attempt facts; the completed count advances only after Storage succeeds. */
export function uploadedPhotoProgressFacts(
  value: unknown,
): UploadedPhotoProgressFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = uploadedPhotoProgress.get(value);
  return facts ? { ...facts } : null;
}

function extensionFor(photo: File): string {
  switch (photo.type) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

function validateEntry(entry: PendingUploadEntry): void {
  if (entry.photos.length < 1) {
    throw new Error("Choose at least one photo for each item.");
  }
  if (entry.photos.length > 4) {
    throw new Error("Up to 4 photos per item.");
  }
  for (const photo of entry.photos) {
    if (!(photo instanceof File) || !ACCEPTED_PHOTO_TYPES.has(photo.type)) {
      throw new Error("Unsupported file type. Use PNG, JPEG, or WEBP.");
    }
  }
}

/**
 * Upload every private object first, then atomically create all items/runs and
 * enqueue their identifiers-only envelopes. Until the RPC commits, no worker
 * can observe a partial batch. Upload failures are cleaned immediately. If the
 * RPC outcome is ambiguous, replay lookup proves whether this batch committed
 * before this call removes any private objects.
 */
export async function stageUploadEntries(
  input: StageUploadEntriesInput,
  dependencies: UploadStagingDependencies,
): Promise<PipelineStageBatchResult> {
  if (input.entries.length < 1) throw new Error("Add at least one item.");
  input.entries.forEach(validateEntry);

  const cleanupId = crypto.randomUUID();
  const uploads: Array<{ path: string; photo: File; entryIndex: number }> = [];
  const stagedEntries: PipelineStageBatchInput["entries"] = input.entries.map(
    (entry, entryIndex) => {
      const photoPaths = entry.photos.map((photo, photoIndex) => {
        const path = [
          input.userId,
          "pipeline-staging",
          input.batchId,
          String(entryIndex),
          `${photoIndex}-${crypto.randomUUID()}.${extensionFor(photo)}`,
        ].join("/");
        uploads.push({ path, photo, entryIndex });
        return path;
      });
      return {
        idempotencyKey: entry.idempotencyKey,
        source: entry.source,
        autopilotEnabled: entry.autopilotEnabled,
        photoPaths,
        costBasis: entry.costBasis,
      };
    },
  );
  const plannedPaths = uploads.map(({ path }) => path);
  const uploadedPaths: string[] = [];
  const uploadedPhotoCounts = input.entries.map(() => 0);
  let cleanupIntentRecorded = false;
  let stagingAttempted = false;

  const notifyUploadProgress = (
    facts: UploadedPhotoProgressFacts,
  ): void => {
    try {
      const observation = dependencies.onUploadProgress?.(
        createUploadProgressSnapshot(facts),
      );
      void Promise.resolve(observation).catch(() => undefined);
    } catch {
      // Optional UI guidance observes upload truth; it never owns producer
      // success, cleanup, or the durable staging transaction.
    }
  };

  const resolveCleanupIntent = async (): Promise<void> => {
    if (!cleanupIntentRecorded) return;
    try {
      await dependencies.resolveCleanupIntent(cleanupId);
    } catch {
      // Keep the durable intent. Retention must verify that no item references
      // a path before removing it, so a committed run remains safe.
    }
  };

  try {
    await dependencies.recordCleanupIntent({
      cleanupId,
      userId: input.userId,
      batchId: input.batchId,
      photoPaths: plannedPaths,
    });
    cleanupIntentRecorded = true;

    for (const [entryIndex, entry] of input.entries.entries()) {
      notifyUploadProgress({
        uploadSessionId: cleanupId,
        entryIndex,
        uploadedPhotoCount: 0,
        plannedPhotoCount: entry.photos.length,
      });
    }

    for (const { path, photo, entryIndex } of uploads) {
      await dependencies.upload(path, photo);
      uploadedPaths.push(path);
      uploadedPhotoCounts[entryIndex] += 1;
      notifyUploadProgress({
        uploadSessionId: cleanupId,
        entryIndex,
        uploadedPhotoCount: uploadedPhotoCounts[entryIndex],
        plannedPhotoCount: input.entries[entryIndex]?.photos.length ?? null,
      });
    }

    stagingAttempted = true;
    const result = await dependencies.stageAndEnqueue({
      batchId: input.batchId,
      userId: input.userId,
      dailyLimit: input.dailyLimit,
      perMinuteLimit: input.perMinuteLimit,
      entries: stagedEntries,
    });
    await resolveCleanupIntent();
    return result;
  } catch (error) {
    const losingIdempotentRace =
      error instanceof Error &&
      error.message.includes(
        "Pipeline idempotency key conflicts with staged input",
      );
    let cleanupConfirmed = !stagingAttempted;
    if (stagingAttempted) {
      try {
        const replay = await dependencies.findReplay({
          batchId: input.batchId,
          userId: input.userId,
          entries: input.entries.map((entry) => ({
            idempotencyKey: entry.idempotencyKey,
            source: entry.source,
            autopilotEnabled: entry.autopilotEnabled,
            photoCount: entry.photos.length,
            costBasis: entry.costBasis,
          })),
        });
        if (replay.length > 0) {
          if (losingIdempotentRace && uploadedPaths.length > 0) {
            try {
              await dependencies.remove(plannedPaths);
              await resolveCleanupIntent();
            } catch {
              // The winner remains authoritative. The durable cleanup intent
              // retains this losing request's unreferenced paths.
            }
          } else {
            await resolveCleanupIntent();
          }
          return replay;
        }
        cleanupConfirmed = true;
      } catch {
        // The producer outcome is still ambiguous. Keep the private objects so
        // a committed run cannot lose its photos. The durable cleanup intent
        // keeps the exact paths available after the ambiguity clears.
      }
    }

    if (cleanupConfirmed && cleanupIntentRecorded) {
      try {
        await dependencies.remove(plannedPaths);
        await resolveCleanupIntent();
      } catch {
        // Preserve the staging error. The durable cleanup intent owns only
        // this request's planned paths and remains pending for retention.
      }
    }
    throw error;
  }
}
