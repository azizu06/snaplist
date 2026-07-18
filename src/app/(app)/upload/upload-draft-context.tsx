"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ACCEPT,
  MAX_PHOTOS,
  appendAcceptedPhotos,
} from "@/lib/capture-progress";

export { ACCEPT, MAX_PHOTOS, appendAcceptedPhotos };
export type { AppendAcceptedPhotosResult } from "@/lib/capture-progress";

/**
 * Accepted image types + the per-listing photo cap. All photos go into ONE
 * vision call, so the cap bounds cost/latency (PRD). Exported so the upload form
 * reuses the same values it enforces here.
 */
export interface UploadDraft {
  captureId: string;
  files: File[];
  previews: string[];
  addFiles: (incoming: FileList | File[]) => void;
  removeAt: (index: number) => void;
  clear: () => void;
}

const UploadDraftContext = createContext<UploadDraft | null>(null);

/**
 * Holds the pending upload photos ABOVE the page, in the persistent (app)
 * layout, so a half-built listing survives in-app navigation: a seller can add
 * photos, pop over to Home or the inbox, come back, and the photos are still
 * there instead of resetting to zero. The capture ID lives here too, so an
 * error redirect retries the same idempotency key while these photos remain.
 * The object URLs live as long as this provider does and are revoked only when
 * a photo is removed, so previews never dangle. A full page reload still starts
 * fresh — File objects can't be serialized — which is the expected limit.
 */
export function UploadDraftProvider({
  children,
  initialCaptureId,
}: {
  children: React.ReactNode;
  initialCaptureId: string;
}) {
  const [captureId, setCaptureId] = useState(initialCaptureId);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  // Refs mirror state so the handlers read current values without being
  // re-created, and so object-URL creation/revocation never runs inside a
  // StrictMode-double-invoked state updater.
  const filesRef = useRef<File[]>([]);
  const previewsRef = useRef<string[]>([]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const result = appendAcceptedPhotos(filesRef.current, incoming);
    if (result.added.length === 0) return;
    const urls = result.added.map((f) => URL.createObjectURL(f));
    filesRef.current = result.files;
    setFiles(result.files);
    setPreviews((prev) => [...prev, ...urls].slice(0, MAX_PHOTOS));
  }, []);

  const removeAt = useCallback((index: number) => {
    const url = previewsRef.current[index];
    if (url) URL.revokeObjectURL(url);
    const nextFiles = filesRef.current.filter((_, i) => i !== index);
    const nextPreviews = previewsRef.current.filter((_, i) => i !== index);
    filesRef.current = nextFiles;
    previewsRef.current = nextPreviews;
    setFiles(nextFiles);
    setPreviews(nextPreviews);
    if (nextFiles.length === 0) setCaptureId(crypto.randomUUID());
  }, []);

  const clear = useCallback(() => {
    previewsRef.current.forEach((u) => URL.revokeObjectURL(u));
    filesRef.current = [];
    previewsRef.current = [];
    setFiles([]);
    setPreviews([]);
    setCaptureId(crypto.randomUUID());
  }, []);

  return (
    <UploadDraftContext.Provider
      value={{ captureId, files, previews, addFiles, removeAt, clear }}
    >
      {children}
    </UploadDraftContext.Provider>
  );
}

export function useUploadDraft(): UploadDraft {
  const ctx = useContext(UploadDraftContext);
  if (!ctx) {
    throw new Error("useUploadDraft must be used within an UploadDraftProvider");
  }
  return ctx;
}
