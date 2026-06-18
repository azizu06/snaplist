"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname();
  useEffect(() => {
    clear();
    // Consume the ?new=1 signal ONCE: strip it from the URL so a later Back /
    // refresh / bookmark to this same review can't re-fire and clear a DIFFERENT
    // in-progress upload draft (Codex). replaceState (not the Next router) keeps
    // it cheap — no RSC refetch — since nothing on the page depends on the param;
    // only `new` is removed, any co-param is preserved.
    const params = new URLSearchParams(window.location.search);
    if (params.has("new")) {
      params.delete("new");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    }
  }, [clear, pathname]);
  return null;
}
