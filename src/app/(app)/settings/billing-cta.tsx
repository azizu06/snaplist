"use client";

import { useState } from "react";
import { buttonClasses, type ButtonVariant } from "@/components/ui/button-styles";

/**
 * Billing CTA (issue #64) — the ONE way the in-app UI starts billing: POST the
 * billing endpoint (`/api/billing/checkout` to subscribe, `/api/billing/portal`
 * to manage) and follow the returned hosted Stripe `{ url }`. Those routes are the
 * single billing interface (they also back the Stripe webhook), so the UI never
 * reimplements any Stripe logic — it just calls them. A POST (not an `<a href>`)
 * because the routes are POST-only and auth/rate-limited.
 */
export function BillingCta({
  endpoint,
  label,
  variant = "primary",
}: {
  endpoint: "/api/billing/checkout" | "/api/billing/portal";
  label: string;
  variant?: ButtonVariant;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data: { url?: string; error?: string } = await res
        .json()
        .catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url; // hand off to Stripe's hosted page
        return;
      }
      setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    }
    setPending(false); // only reached on failure (success navigates away)
  }

  return (
    <div className="flex flex-col gap-2 self-start">
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className={buttonClasses(variant, "md")}
      >
        {pending ? "Redirecting…" : label}
      </button>
      {error ? <p className="text-[13px] text-danger-soft-fg">{error}</p> : null}
    </div>
  );
}
