"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * Animated confidence gauge (issue #51) — the signal-based confidence score
 * as a semicircular arc that sweeps in on mount. Mirrors the marketing
 * ConfidenceGaugeVisual so the product keeps the promise the site makes.
 */
export function ConfidenceGauge({
  value,
  size = 150,
}: {
  /** 0..1 confidence; null renders an empty gauge */
  value: number | null;
  size?: number;
}) {
  const reduced = useReducedMotion();
  const pct = value != null ? Math.round(value * 100) : null;
  // Semicircle r=54 → arc length ≈ 169.6
  const ARC = 169.6;
  const target = value != null ? ARC * value : 0;

  return (
    <div style={{ width: size }} className="shrink-0">
      <svg viewBox="0 0 140 84" className="w-full" aria-hidden>
        <path
          d="M 16 76 A 54 54 0 0 1 124 76"
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <motion.path
          d="M 16 76 A 54 54 0 0 1 124 76"
          fill="none"
          stroke="url(#confidence-grad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${target} ${ARC + 4}`}
          initial={reduced ? false : { strokeDasharray: `0 ${ARC + 4}` }}
          animate={{ strokeDasharray: `${target} ${ARC + 4}` }}
          transition={{ duration: 1.1, ease: [0.22, 0.9, 0.3, 1] }}
        />
        <defs>
          <linearGradient
            id="confidence-grad"
            x1="16"
            y1="76"
            x2="124"
            y2="76"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#5a36f0" />
            <stop offset="1" stopColor="#a960ee" />
          </linearGradient>
        </defs>
        <text
          x="70"
          y="66"
          textAnchor="middle"
          fill="var(--color-fg-strong)"
          fontSize="23"
          fontWeight="700"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {pct != null ? `${pct}%` : "—"}
        </text>
      </svg>
    </div>
  );
}
