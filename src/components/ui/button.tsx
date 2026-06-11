"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button-styles";

/**
 * Buttons (audit X-3/X-6). `PendingButton` is the async-state workhorse: it
 * sits inside the EXISTING form actions and flips to a spinner+label while the
 * action runs (useFormStatus — presentation only, AC5-safe). The class builder
 * lives in button-styles.ts (server-safe); it is re-exported here for client
 * consumers.
 */

export { buttonClasses, type ButtonVariant } from "./button-styles";

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
  size?: ButtonSize;
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
