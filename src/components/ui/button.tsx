"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";

/**
 * Buttons (audit X-3/X-6). `PendingButton` is the async-state workhorse: it
 * sits inside the EXISTING form actions and flips to a spinner+label while the
 * action runs (useFormStatus — presentation only, AC5-safe). Use `buttonClasses`
 * for plain links/buttons that need the same look without client JS.
 */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-solid text-accent-fg hover:bg-accent-hover border border-transparent shadow-xs",
  secondary:
    "bg-surface text-fg border border-border-strong hover:bg-surface-2 shadow-xs",
  danger:
    "bg-danger-solid text-white hover:opacity-90 border border-transparent shadow-xs",
  ghost: "bg-transparent text-muted hover:bg-surface-2 border border-transparent",
};

const SIZE_CLASSES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
} as const;

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: keyof typeof SIZE_CLASSES = "md",
): string {
  return `inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-60 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}`;
}

export function PendingButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className = "",
}: {
  children: React.ReactNode;
  /** Label shown next to the spinner while the surrounding form action runs. */
  pendingLabel: string;
  variant?: ButtonVariant;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${buttonClasses(variant, size)} ${className}`}
    >
      {pending ? (
        <>
          <Spinner className="size-3.5" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
