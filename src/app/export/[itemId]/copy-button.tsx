"use client";

import { useState } from "react";

/**
 * Copy-to-clipboard button for an export pack block (issue #15). Client-side
 * only because it needs `navigator.clipboard`; the block itself is rendered by
 * the server page and passed in as a plain string.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions / non-secure context) — leave the
      // label unchanged; the user can still select the block manually.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={
        copied
          ? "rounded-md border border-success-border bg-success-soft px-3 py-1.5 text-xs font-medium text-success-soft-fg"
          : "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg shadow-xs transition-colors hover:bg-surface-2"
      }
      aria-label={label}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}
