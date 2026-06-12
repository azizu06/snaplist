"use client";

import { useFormStatus } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

/**
 * Animated toggle switch (Stripe-settings treatment). A REAL submit button —
 * it sits inside the EXISTING `<form action={serverAction}>` and pressing it
 * submits that form, exactly like the PendingButton it replaces (useFormStatus
 * drives the disabled/pending state — presentation only).
 *
 * When `name` is provided, the button submits the NEXT state ("true"/"false")
 * under that name — the same value the hidden `<input name="enabled">` used to
 * carry, so server actions reading `formData.get(name) === "true"` are
 * untouched. While the action is in flight the knob optimistically shows the
 * state being saved, so the toggle responds on press rather than after the
 * server round-trip.
 */
export function Switch({
  checked,
  name,
  disabled = false,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  name?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const { pending } = useFormStatus();
  const reduced = useReducedMotion();

  const isOn = pending ? !checked : checked;

  return (
    <button
      type="submit"
      role="switch"
      aria-checked={isOn}
      aria-label={ariaLabel}
      name={name}
      value={checked ? "false" : "true"}
      disabled={disabled || pending}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
        isOn ? "bg-accent" : "bg-surface-3"
      }`}
    >
      {/* Knob: 20px on a 44px track with 2px padding → 20px of travel. */}
      <motion.span
        aria-hidden
        className="block size-5 rounded-full bg-surface shadow-xs"
        initial={false}
        animate={{ x: isOn ? 20 : 0 }}
        transition={
          reduced
            ? { duration: 0 }
            : { type: "spring", stiffness: 500, damping: 30 }
        }
      />
    </button>
  );
}
