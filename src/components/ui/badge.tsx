import type { StatusTone } from "@/lib/ui/status";

/**
 * Status chip (audit X-4 consumer). The ONLY way a lifecycle / confidence /
 * tier label reaches the screen — pages pass labels from `lib/ui/status`,
 * never raw persisted keys.
 */

const TONE_CLASSES: Record<StatusTone, string> = {
  success:
    "bg-success-soft text-success-soft-fg border border-success-border",
  "success-solid": "bg-success-solid text-white border border-success-solid",
  warning:
    "bg-warning-soft text-warning-soft-fg border border-warning-border",
  danger: "bg-danger-soft text-danger-soft-fg border border-danger-border",
  neutral: "bg-surface-2 text-muted border border-border",
};

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "bg-success",
  "success-solid": "bg-white",
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
