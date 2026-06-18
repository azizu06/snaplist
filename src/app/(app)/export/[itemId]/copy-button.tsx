"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Copy-to-clipboard button for an export pack block (issue #15; redesign/export).
 * Client-side only because it needs `navigator.clipboard`; the block itself is
 * rendered by the server page and passed in as a plain string. The idle state
 * carries a copy glyph (Shopify-grade "obvious affordance"); on success the
 * whole label swaps to a green "Copied" with a checkmark on a small spring
 * scale (the ui-design-principles micro-interaction — confirm the action), then
 * reverts after ~1.6s. `fullWidth` is the mobile thumb-reach variant.
 */
export function CopyButton({
  text,
  label,
  fullWidth = false,
}: {
  text: string;
  label: string;
  fullWidth?: boolean;
}) {
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

  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-[13.5px] font-medium transition-colors min-h-9";
  const width = fullWidth ? "w-full py-2.5" : "";
  const tone = copied
    ? "border border-success-border bg-success-soft text-success-soft-fg"
    : "border border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-2";

  return (
    <button
      type="button"
      onClick={copy}
      className={`${base} ${width} ${tone}`}
      aria-label={label}
      aria-live="polite"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "copied" : "idle"}
          className="inline-flex items-center gap-1.5"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          transition={
            reduced
              ? { duration: 0.1 }
              : { type: "spring", stiffness: 520, damping: 30 }
          }
        >
          {copied ? (
            <>
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
