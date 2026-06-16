import type { StatusTone } from "@/lib/ui/status";

/**
 * Status chip (audit X-4 consumer). The ONLY way a lifecycle / confidence /
 * tier label reaches the screen — pages pass labels from `lib/ui/status`,
 * never raw persisted keys.
 */

/**
 * Restrained status chrome (home polish round 1). Every pill shares ONE calm
 * neutral chrome so a column of statuses reads quietly; COLOR is carried only by
 * the small dot, plus a faint text tint for the two states that matter — Live and
 * Needs attention. This replaces the old filled amber/green/red pills that made
 * the dashboard noisy. The in-flight states (Draft, Queued, Processing) map to
 * `neutral` upstream and are told apart by their label, not by a fill.
 */
const NEUTRAL_PILL = "bg-surface-2 text-muted border border-border";
const TONE_CLASSES: Record<StatusTone, string> = {
  success: NEUTRAL_PILL,
  "success-solid": "bg-surface-2 text-success-soft-fg border border-border",
  warning: NEUTRAL_PILL,
  danger: "bg-surface-2 text-danger-soft-fg border border-border",
  neutral: NEUTRAL_PILL,
};

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "bg-success",
  "success-solid": "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-faint",
};

export function StatusBadge({
  label,
  tone,
  dot = true,
}: {
  label: string;
  tone: StatusTone;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${TONE_CLASSES[tone]}`}
    >
      {dot ? (
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${DOT_CLASSES[tone]}`}
        />
      ) : null}
      {label}
    </span>
  );
}
