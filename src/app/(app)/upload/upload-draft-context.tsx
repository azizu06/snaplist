"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Accepted image types + the per-listing photo cap. All photos go into ONE
 * vision call, so the cap bounds cost/latency (PRD). Exported so the upload form
 * reuses the same values it enforces here.
 */
export const ACCEPT = "image/png,image/jpeg,image/webp";
export const MAX_PHOTOS = 4;
const ACCEPTED_TYPES = ACCEPT.split(",");

export interface UploadDraft {
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
 * there instead of resetting to zero. The object URLs live as long as this
 * provider does and are revoked only when a photo is removed, so previews never
 * dangle. A full page reload still starts fresh — File objects can't be
 * serialized — which is the expected limit.
 */
export function UploadDraftProvider({
  children,
}: {
  children: React.ReactNode;
}) {
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
    const room = MAX_PHOTOS - filesRef.current.length;
    if (room <= 0) return;
    const accepted = Array.from(incoming)
      .filter((f) => ACCEPTED_TYPES.includes(f.type))
      .slice(0, room);
    if (accepted.length === 0) return;
    const urls = accepted.map((f) => URL.createObjectURL(f));
    setFiles((prev) => [...prev, ...accepted].slice(0, MAX_PHOTOS));
    setPreviews((prev) => [...prev, ...urls].slice(0, MAX_PHOTOS));
  }, []);

  const removeAt = useCallback((index: number) => {
    const url = previewsRef.current[index];
    if (url) URL.revokeObjectURL(url);
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    previewsRef.current.forEach((u) => URL.revokeObjectURL(u));
    setFiles([]);
    setPreviews([]);
  }, []);

  return (
    <UploadDraftContext.Provider
      value={{ files, previews, addFiles, removeAt, clear }}
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
