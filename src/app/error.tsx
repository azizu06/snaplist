"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Logo } from "@/components/logo";

/**
 * Branded runtime error boundary (redesign: neutral + green). The app had no
 * custom error UI — an uncaught render/server error fell through to Next's bare
 * default. This is the designed recovery: a calm, on-palette page that says what
 * happened plainly (no "Oops!"), offers `reset()` to retry the segment, and a
 * way home. Client component by contract (error boundaries must be); it sits
 * under the root layout, so it themes light/dark for free.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console for local debugging; production wires a reporter.
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-1 flex-col items-center justify-center gap-7 px-6 py-16 text-center">
      <Link href="/" aria-label="SnapList home" className="inline-flex">
        <Logo markClassName="size-9" />
      </Link>

      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-faint"
        >
          <span className="h-[2px] w-6 rounded-full bg-danger" />
          Something broke
        </span>
        <h1 className="font-display text-[clamp(26px,6vw,34px)] font-bold leading-tight tracking-tight text-fg-strong text-balance">
          Something went wrong on our end
        </h1>
        <p className="max-w-[42ch] text-[15px] leading-relaxed text-muted text-pretty">
          The page hit an unexpected error. Trying again usually clears it.
        </p>
        {error.digest ? (
          <p className="mt-1 text-[12px] text-faint" data-nums>
            Reference: {error.digest}
          </p>
        ) : null}
      </div>

      <div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover motion-safe:active:scale-[0.98]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
