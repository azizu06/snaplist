import Image from "next/image";
import Link from "next/link";

/**
 * The page's only crisp boundary.
 *
 * The v6 footer carries three inert destination tokens: LEGAL_PRIVACY_PENDING,
 * LEGAL_TERMS_PENDING, and COMPANY_CONTACT_PENDING. Privacy and Contact resolve
 * here, to the two pages App Review needs. Terms of Use does not: SnapList has
 * no terms document, and inventing one is not a marketing decision. The row is
 * omitted rather than shipped as a link to nothing. See the #191 PR body.
 */
export function SiteFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-shell mkt-footer__inner">
        <div className="mkt-footer__row">
          <div className="mkt-footer__col">
            <div className="mkt-footer__head">Legal</div>
            <ul className="mkt-footer__list">
              <li>
                <Link className="mkt-footer__link" href="/privacy">
                  <span className="mkt-underline">Privacy Policy</span>
                </Link>
              </li>
            </ul>
          </div>

          <div className="mkt-footer__brand">
            <span className="mkt-lockup">
              <Image
                className="mkt-lockup__mark"
                src="/brand/scout-lockup.png"
                alt=""
                aria-hidden="true"
                width={443}
                height={388}
              />
              <span className="mkt-lockup__word">SnapList</span>
            </span>
          </div>

          <div className="mkt-footer__col">
            <div className="mkt-footer__head">Company</div>
            <ul className="mkt-footer__list">
              <li>
                <Link className="mkt-footer__link" href="/support">
                  <span className="mkt-underline">Support</span>
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mkt-footer__legal">
          <span>&copy; 2026 SnapList.</span>
        </div>
      </div>
    </footer>
  );
}
