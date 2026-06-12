/**
 * SnapList brand mark (issue #49) — a camera aperture whose blades form the
 * iris, in the iris-indigo gradient. One source of truth: the nav, footer,
 * auth screen, app shell, and favicon (src/app/icon.svg mirrors this) all
 * render the same geometry.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <defs>
        <linearGradient id="iris-grad" x1="10" y1="6" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c88e8" />
          <stop offset="0.55" stopColor="#5e6ad2" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="#101113" />
      <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke="#2e3035" strokeWidth="1" />
      {/* aperture blades */}
      <g stroke="url(#iris-grad)" strokeWidth="3.2" strokeLinecap="round" fill="none">
        <circle cx="24" cy="24" r="14.5" opacity="0.45" />
        <path d="M26.9 18.4 30.8 31" />
        <path d="M19.7 18.4h14.4" />
        <path d="m17.1 24 4.5-12.1" />
        <path d="M21.1 29.6 14.9 15.9" />
        <path d="M28.3 29.6H12.4" />
        <path d="m30.9 24-5.1 13.9" />
      </g>
      {/* flash dot */}
      <circle cx="24" cy="24" r="2.1" fill="#f7f8f8" />
    </svg>
  );
}

export function Logo({
  className,
  markClassName = "size-8",
  wordmark = true,
}: {
  className?: string;
  markClassName?: string;
  wordmark?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark className={markClassName} />
      {wordmark ? (
        <span className="font-display text-[17px] font-bold tracking-tight">
          SnapList
        </span>
      ) : null}
    </span>
  );
}
