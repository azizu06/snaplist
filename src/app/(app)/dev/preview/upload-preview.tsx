"use client";

import { useEffect } from "react";
import { UploadView } from "@/app/(app)/upload/upload-form";

const PHOTO = "/demo/reseller/ps5.webp";

/**
 * Dev-only real upload interaction. The `filled` capture fetches a local photo,
 * places it into the shipped file input, and dispatches the browser's change
 * event. That means the captured preview is produced by UploadView's actual
 * draft/file path rather than a hand-built imitation or a preview-only prop.
 */
export function UploadPreview({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  useEffect(() => {
    const capture = new URLSearchParams(window.location.search).get("capture");
    let cancelled = false;

    async function prepare() {
      if (capture !== "filled") {
        document.documentElement.dataset.demoInteractionReady = "true";
        return;
      }

      const response = await fetch(PHOTO);
      if (!response.ok) throw new Error(`Could not load capture fixture: ${response.status}`);
      const blob = await response.blob();
      if (cancelled) return;

      // Exercise #137's real multi-select library input. The separate camera
      // input keeps capture="environment" untouched; both flow through the
      // shared PhotoInputActions validation/append path.
      const input = document.querySelector<HTMLInputElement>("#single-item-library-input");
      if (!input) throw new Error("Real upload picker was not mounted");
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "sony-playstation-5.webp", { type: blob.type }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) document.documentElement.dataset.demoInteractionReady = "true";
        });
      });
    }

    void prepare();
    return () => {
      cancelled = true;
      delete document.documentElement.dataset.demoInteractionReady;
    };
  }, []);

  return (
    <UploadView
      action={action}
      actionError={null}
      captureId="00000000-0000-4000-8000-000000000159"
    />
  );
}
