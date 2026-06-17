"use client";

import { useEffect } from "react";
import { useUploadDraft } from "../../upload/upload-draft-context";

/**
 * Consume the pending-upload draft once an upload has produced a listing.
 *
 * The draft (the seller's chosen `File[]` + previews) lives in the persistent
 * (app) layout so a half-built listing survives in-app navigation — add photos,
 * pop over to Home or the inbox, come back, photos intact. That persistence has
 * a sharp edge: after a SUCCESSFUL upload the action redirects here to /review,
 * but the layout (and so the draft) stays mounted. Without clearing it, going
 * back to /upload would re-hydrate the old photos into the hidden file input and
 * let "Build my listing" resubmit the same item as a DUPLICATE (Codex P2).
 *
 * Reaching this screen is the unambiguous "the upload succeeded and produced this
 * item" signal: every FAILURE path redirects back to /upload?error=… (photos
 * preserved there for the retry), never here. So clear the draft on mount. When
 * the seller arrived without an in-flight upload the draft is already empty and
 * clear() is a no-op (idempotent — also safe under StrictMode's double-invoke and
 * a /review re-render after a sharpen error). Renders nothing.
 */
export function ConsumeUploadDraft() {
  const { clear } = useUploadDraft();
  useEffect(() => {
    clear();
  }, [clear]);
  return null;
}
