"use client";

import { useEffect } from "react";
import { UploadView } from "@/app/(app)/upload/upload-form";

const PHOTO = "/demo/authentic/acer-predator-a1-open.jpg";

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

      const input = document.querySelector<HTMLInputElement>("#photo-picker");
      if (!input) throw new Error("Real upload picker was not mounted");
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "acer-predator-helios-300.jpg", { type: blob.type }));
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

  return <UploadView action={action} actionError={null} />;
}
