"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Copy-to-clipboard button for an export pack block (issue #15). Client-side
 * only because it needs `navigator.clipboard`; the block itself is rendered by
 * the server page and passed in as a plain string. On success the label swaps
 * to "Copied ✓" with a small spring scale and reverts after ~1.6s.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const reduced = useReducedMotion();

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
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
          ? "rounded-md border border-success-border bg-success-soft px-3 py-1.5 text-[13.5px] font-medium text-success-soft-fg"
          : "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[13.5px] font-medium text-fg shadow-xs transition-colors hover:bg-surface-2"
      }
      aria-label={label}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "copied" : "idle"}
          className="inline-block"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          transition={
            reduced
              ? { duration: 0.1 }
              : { type: "spring", stiffness: 520, damping: 30 }
          }
        >
          {copied ? "Copied ✓" : "Copy"}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
