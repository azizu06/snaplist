"use client";

import { useRef } from "react";
import { useEscapeToClose, useModalFocus } from "@/components/ui/overlay-behavior";

/** Confirm dialog for destructive actions (mirrors Shopify's "Archive N?"
 *  modal; used by the dashboard bulk bar and the bulk-edit discard guard).
 *  Full modal keyboard contract (#105): Escape cancels, focus lands on the
 *  cancel button (the safe default — it gates a permanent action), Tab is
 *  trapped, and focus returns to the trigger on close. Mounting after the
 *  host overlay registers it above that overlay on the escape stack, so
 *  Escape here closes only the confirm. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(true, onCancel);
  useModalFocus(true, boxRef);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      // Backdrop covers the full viewport, but the dialog box centers over the
      // CONTENT area: left padding = sidebar width on sm+ so it doesn't drift
      // right-of-center past the side panel (mobile has no sidebar → plain p-4).
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(26,26,26,0.4)] p-4 backdrop-blur-[2px] sm:pl-[calc(var(--sidebar-w)+1rem)]"
    >
      <div
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-[16px] font-bold tracking-tight text-fg-strong">{title}</h2>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            className="rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-lg px-3.5 py-2 text-[14px] font-semibold shadow-xs transition-colors disabled:opacity-50 ${
              danger
                ? "bg-danger text-white hover:bg-danger-solid"
                : "bg-primary text-primary-fg hover:bg-primary-hover"
            }`}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
