import { appStoreURL } from "@/lib/marketing/site";

/**
 * The page's only call to action, in the three sizes the v6 composition uses:
 * header (`sm`), mobile menu (`md`), hero (default), final CTA (`lg`).
 *
 * SnapList has no App Store product page until #380 submits one, which the
 * design carries as the inert token APP_STORE_DESTINATION_PENDING. Rather than
 * point a download button at a URL that does not resolve, the unresolved state
 * renders a non-interactive control that says what it is waiting for. Setting
 * NEXT_PUBLIC_APP_STORE_URL turns all three into real links with no code change.
 */
export function AppStoreButton({
  size = "default",
}: {
  size?: "sm" | "md" | "default" | "lg";
}) {
  const href = appStoreURL();
  const className = ["mkt-appstore", size === "default" ? null : `mkt-appstore--${size}`]
    .filter(Boolean)
    .join(" ");

  if (!href) {
    // Plain text, not a disabled button: there is nothing to activate yet, and a
    // control that announces itself as disabled implies it will become enabled
    // in this session. The words carry the state instead.
    return (
      <span className={className} data-pending="true">
        <AppleGlyph size={size} muted />
        <span className="mkt-appstore__stack">
          <span className="mkt-appstore__kicker">Coming to the</span>
          <span className="mkt-appstore__name">App Store</span>
        </span>
      </span>
    );
  }

  return (
    <a className={className} href={href} aria-label="Download SnapList on the App Store">
      <AppleGlyph size={size} />
      {/* The two-line lockup is one label to a screen reader; aria-label above
          carries the accessible name so "Download on the / App Store" is not
          announced as two fragments. */}
      <span className="mkt-appstore__stack" aria-hidden="true">
        <span className="mkt-appstore__kicker">Download on the</span>
        <span className="mkt-appstore__name">App Store</span>
      </span>
    </a>
  );
}

const GLYPH_PX = { sm: 18, md: 20, default: 26, lg: 28 } as const;

function AppleGlyph({
  size,
  muted = false,
}: {
  size: keyof typeof GLYPH_PX;
  muted?: boolean;
}) {
  const px = GLYPH_PX[size];
  return (
    <svg
      aria-hidden="true"
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill={muted ? "currentColor" : "#FFFFFF"}
    >
      <path d="M16.365 1.43c0 1.14-.42 2.2-1.13 3.02-.85.99-2.24 1.75-3.4 1.66-.14-1.1.4-2.28 1.06-3.03.75-.85 2.06-1.5 3.16-1.55.05.31.35.24.31.9zM20.8 17.06c-.57 1.32-.85 1.91-1.58 3.08-1.03 1.64-2.48 3.68-4.28 3.7-1.6.01-2.01-1.04-4.18-1.03-2.17.01-2.62 1.05-4.22 1.04-1.8-.02-3.17-1.86-4.2-3.5-2.88-4.6-3.18-9.99-1.4-12.86 1.26-2.03 3.25-3.22 5.12-3.22 1.9 0 3.1 1.05 4.67 1.05 1.52 0 2.45-1.05 4.65-1.05 1.66 0 3.42.9 4.68 2.46-4.11 2.25-3.44 8.11.42 9.28z" />
    </svg>
  );
}
