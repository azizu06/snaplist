import Image from "next/image";
import Link from "next/link";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { FOOTER } from "@/lib/marketing/site";

/** One final waitlist and legal destination block. */
export function SiteFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-shell mkt-footer__inner">
        <h2 className="mkt-footer__title">{FOOTER.title}</h2>
        <WaitlistForm />
        <nav className="mkt-footer__links" aria-label="Company and legal">
          <Link className="mkt-footer__link" href="/privacy">Privacy</Link>
          <span aria-hidden="true">·</span>
          <Link className="mkt-footer__link" href="/support">Support</Link>
          <span aria-hidden="true">·</span>
          <a className="mkt-footer__link" href="#top">SnapList</a>
        </nav>
        <div className="mkt-footer__legal">&copy; 2026 SnapList.</div>
      </div>
      <div className="mkt-footer__landscape" aria-hidden="true">
        <div className="mkt-footer__hill mkt-footer__hill--back" />
        <div className="mkt-footer__hill mkt-footer__hill--front" />
        <Image
          src="/brand/scout-lockup.png"
          alt=""
          width={443}
          height={388}
          className="mkt-footer__scout"
        />
      </div>
    </footer>
  );
}
