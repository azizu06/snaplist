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
 * The review page renders this ONLY when the fresh-upload signal is present (the
 * upload action redirects to /review/:id?new=1; failure paths go to /upload?error=…,
 * never here). That gating matters: /review is also opened for EXISTING items, and
 * clearing on every mount would wipe a half-built upload draft a seller left on
 * /upload. So mount === "this review came from a just-completed upload" → clear the
 * draft. Idempotent: a refresh of the ?new=1 URL or StrictMode's double-invoke just
 * clears an already-empty draft. Renders nothing.
 */
export function ConsumeUploadDraft() {
  const { clear } = useUploadDraft();
  useEffect(() => {
    clear();
  }, [clear]);
  return null;
}
