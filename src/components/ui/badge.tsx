import type { StatusTone } from "@/lib/ui/status";

/**
 * Status chip (audit X-4 consumer). The ONLY way a lifecycle / confidence /
 * tier label reaches the screen — pages pass labels from `lib/ui/status`,
 * never raw persisted keys.
 */

/**
 * Color-coded status chrome (Shopify Products parity). Each tone is a soft
 * tonal badge — a tinted fill + same-hue text + a saturated dot — so a column
 * of statuses is scannable at a glance and the meaningful states pop: Active
 * green, Scheduled/Processing blue, Needs attention red, Draft/Archived a calm
 * grey. Tints come from the semantic `*-soft` tokens, which carry their own
 * light + dark values, so this reads correctly in both themes.
 */
const NEUTRAL_PILL = "bg-surface-2 text-muted border border-border";
const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-soft text-success-soft-fg",
  "success-solid": "bg-success-soft text-success-soft-fg",
  warning: "bg-warning-soft text-warning-soft-fg",
  danger: "bg-danger-soft text-danger-soft-fg",
  info: "bg-info-soft text-info-soft-fg",
  neutral: NEUTRAL_PILL,
};

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "bg-success",
  "success-solid": "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info-soft-fg",
  neutral: "bg-faint",
};

export function StatusBadge({
  label,
  tone,
  dot = true,
  pulse = false,
  icon,
}: {
  label: string;
  tone: StatusTone;
  dot?: boolean;
  /** Pulses the dot for transient "working" states (e.g. Processing) so they
   *  read as active and don't blur against same-hue static states. Motion-safe:
   *  reduced-motion users get a steady dot. */
  pulse?: boolean;
  /** Replaces the leading dot with a glyph so two same-tone states stay
   *  distinguishable. `clock` marks Scheduled ("queued to publish") against
   *  Processing's pulsing dot — same info hue, different phase. Honors `dot`: a
   *  `dot={false}` badge shows neither. */
  icon?: "clock";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[13px] font-medium ${TONE_CLASSES[tone]}`}
    >
      {dot ? (
        icon === "clock" ? (
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-3 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 1.5" />
          </svg>
        ) : (
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${DOT_CLASSES[tone]} ${
              pulse ? "motion-safe:animate-pulse" : ""
            }`}
          />
        )
      ) : null}
      {label}
    </span>
  );
}
