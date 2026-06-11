"use client";

import { useState } from "react";
import { PendingButton } from "@/components/ui/button";

/**
 * Sign in / create account (audit L-1…L-4): explicit segmented modes so a
 * first-timer knows no account is needed yet, mode-specific CTA labels, and a
 * pending submit. Both server actions are the existing ones — the segment only
 * switches which formAction the single primary button posts to (AC5-safe).
 */
export function LoginForm({
  next,
  signIn,
  signUp,
}: {
  next?: string;
  signIn: (formData: FormData) => Promise<void>;
  signUp: (formData: FormData) => Promise<void>;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Sign in or create account"
        className="grid grid-cols-2 rounded-lg border border-border bg-surface-2 p-1"
      >
        {(
          [
            { key: "signin", label: "Sign in" },
            { key: "signup", label: "Create account" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={
              mode === key
                ? "rounded-md bg-surface px-3 py-1.5 text-sm font-medium text-fg-strong shadow-xs"
                : "rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-fg"
            }
          >
            {label}
          </button>
        ))}
      </div>

      <form className="flex flex-col gap-3" action={mode === "signin" ? signIn : signUp}>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Password</span>
          <input
            type="password"
            name="password"
            required
            minLength={6}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
          {mode === "signup" ? (
            <span className="text-xs text-faint">At least 6 characters.</span>
          ) : null}
        </label>
        <PendingButton
          pendingLabel={mode === "signin" ? "Signing in…" : "Creating account…"}
          className="mt-1 w-full"
        >
          {mode === "signin" ? "Sign in" : "Create account"}
        </PendingButton>
      </form>
    </div>
  );
}
