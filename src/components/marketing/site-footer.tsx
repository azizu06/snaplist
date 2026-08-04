import Link from "next/link";
import { BrandLockup } from "@/components/marketing/brand-lockup";
import { FOOTER } from "@/lib/marketing/site";

/** A compact lockup and only destinations that exist. */
export function SiteFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-shell mkt-footer__inner">
        <div className="mkt-footer__top">
          <div className="mkt-footer__brand">
            <a href="#top" className="mkt-lockup mkt-footer__lockup" aria-label="SnapList home">
              <BrandLockup />
            </a>
            <p className="mkt-footer__tagline">{FOOTER.tagline}</p>
          </div>
          <nav className="mkt-footer__legal-links" aria-label="Legal">
            {FOOTER.legalLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>
        </div>
        <div className="mkt-footer__divider" />
        <div className="mkt-footer__legal">&copy; 2026 SnapList.</div>
      </div>
    </footer>
  );
}
