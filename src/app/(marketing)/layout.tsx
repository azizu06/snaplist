import { Public_Sans } from "next/font/google";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import "./marketing.css";

/**
 * (marketing) group chrome — the public site (issue #191).
 *
 * The marketing surface is a separate visual identity from the app: white
 * canvas, ink #16181B, action blue #3665F3, Public Sans. Rather than override
 * the app's tokens, everything is scoped under `.mkt` on this root element, so
 * `(auth)` and the Clerk cards keep the app palette untouched. `next-themes` may
 * still put `.dark` on `<html>`; the `.mkt` block repaints its own canvas so the
 * public site stays light either way, which is what the v6 design specifies.
 *
 * There is no signed-in variant. The web app was retired by #604 and the launch
 * client is the iOS app, so this chrome has no account state to reflect.
 */
const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-public-sans",
  display: "swap",
});

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className={`mkt ${publicSans.variable}`}>
      <a className="mkt-skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="mkt-main">
        <span id="top" />
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
