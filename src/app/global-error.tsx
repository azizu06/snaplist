"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary — catches failures in the ROOT layout itself,
 * where the normal error.tsx (which renders inside that layout) can't run. It
 * must supply its own <html>/<body>, and the Tailwind @theme tokens may be
 * exactly what failed to load, so this is intentionally self-contained: inline
 * styles using the locked neutral+green hex values, no imports beyond React.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "20px",
          padding: "64px 24px",
          textAlign: "center",
          background: "#f6f6f7",
          color: "#1a1a1a",
          fontFamily:
            'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div
          aria-hidden
          style={{
            display: "flex",
            height: 40,
            width: 40,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 11,
            background: "linear-gradient(135deg, #1fb88c, #008060)",
            color: "#fff",
            fontWeight: 800,
            fontSize: 16,
          }}
        >
          SL
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            maxWidth: "30ch",
          }}
        >
          Something went wrong
        </h1>
        <p style={{ margin: 0, maxWidth: "42ch", fontSize: 15, lineHeight: 1.6, color: "#6d7175" }}>
          SnapList hit an unexpected error and couldn&apos;t finish loading.
          Trying again usually clears it.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            border: "none",
            cursor: "pointer",
            borderRadius: 8,
            background: "#1a1a1a",
            color: "#fff",
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
