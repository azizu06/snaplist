export const ACCEPT = "image/png,image/jpeg,image/webp";
export const MAX_PHOTOS = 4;
const ACCEPTED_TYPES = ACCEPT.split(",");

export interface AppendAcceptedPhotosResult {
  files: File[];
  added: File[];
  rejectedCount: number;
  overflowCount: number;
}

export interface AcceptedCaptureProgressFacts {
  captureSessionId: string;
  capturedPhotoCount: number;
}

const acceptedCaptureProgress = new WeakMap<
  object,
  AcceptedCaptureProgressFacts
>();

/**
 * Apply the shared accepted-type/cap contract and return an opaque progress
 * snapshot representing the photos that exist in the capture session now.
 */
export function appendAcceptedPhotos(
  existing: readonly File[],
  incoming: FileList | readonly File[],
): AppendAcceptedPhotosResult {
  const candidates = Array.from(incoming);
  const accepted = candidates.filter((file) =>
    ACCEPTED_TYPES.includes(file.type),
  );
  const room = Math.max(0, MAX_PHOTOS - existing.length);
  const added = accepted.slice(0, room);
  const result = {
    files: [...existing, ...added],
    added,
    rejectedCount: candidates.length - accepted.length,
    overflowCount: Math.max(0, accepted.length - room),
  };
  acceptedCaptureProgress.set(result, {
    captureSessionId: crypto.randomUUID(),
    capturedPhotoCount: result.files.length,
  });
  return result;
}

/** Immutable facts available only for snapshots returned by the capture seam. */
export function acceptedCaptureProgressFacts(
  value: unknown,
): AcceptedCaptureProgressFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = acceptedCaptureProgress.get(value);
  return facts ? { ...facts } : null;
}
