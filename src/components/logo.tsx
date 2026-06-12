/**
 * SnapList brand mark — the product initials "SL" set bold on the
 * iris-indigo gradient tile. One source of truth: the nav, footer, auth
 * screen, app shell, and favicon (src/app/icon.svg mirrors this) all render
 * the same geometry.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <defs>
        <linearGradient id="iris-grad" x1="6" y1="4" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7a73ff" />
          <stop offset="0.55" stopColor="#635bff" />
          <stop offset="1" stopColor="#a960ee" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#iris-grad)" />
      <text
        x="24"
        y="25"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="800"
        fontSize="20.5"
        letterSpacing="-0.8"
        fill="#ffffff"
      >
        SL
      </text>
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
