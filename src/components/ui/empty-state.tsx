/**
 * EmptyState (audit X-7, Depop pattern): plain-language headline + one CTA.
 * Every list/collection surface renders this instead of a blank panel.
 * The aperture-iris mark above the title nods to the camera-first capture
 * flow; the blade group drifts slowly (.aperture-blades in globals.css,
 * stilled under prefers-reduced-motion).
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <span
        aria-hidden
        className="mb-1 flex size-[72px] items-center justify-center rounded-full bg-accent-soft/50 text-accent"
      >
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
          <g className="aperture-blades" strokeOpacity="0.55">
            <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
            <line x1="9.69" y1="8" x2="21.17" y2="8" />
            <line x1="7.38" y1="12" x2="13.12" y2="2.06" />
            <line x1="9.69" y1="16" x2="3.95" y2="6.06" />
            <line x1="14.31" y1="16" x2="2.83" y2="16" />
            <line x1="16.62" y1="12" x2="10.88" y2="21.94" />
          </g>
        </svg>
      </span>
      <p className="text-base font-semibold text-fg-strong">{title}</p>
      {detail ? <p className="max-w-sm text-[15px] text-muted">{detail}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
