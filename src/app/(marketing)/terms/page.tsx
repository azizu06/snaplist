import type { Metadata } from "next";
import { SupportChannel } from "@/components/marketing/support-channel";
import { TERMS } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Terms of Use | SnapList",
  description: "Terms for using the SnapList website, waitlist, and app.",
};

export default function TermsPage() {
  return (
    <section className="mkt-shell mkt-shell--prose mkt-doc">
      <h1>Terms of Use</h1>
      <p className="mkt-doc__meta">Last updated 4 August 2026</p>

      <p>
        These terms apply to the SnapList website, waitlist, and app. By using them, you agree to
        use SnapList lawfully and to provide information you are allowed to share.
      </p>

      <h2>Your content and listings</h2>
      <p>{TERMS.content}</p>

      <h2>Your decisions</h2>
      <p>{TERMS.decisions}</p>

      <h2>Waitlist</h2>
      <p>
        If you join the launch waitlist, SnapList uses your email address to send one launch email.
        The <a href="/privacy">privacy policy</a> explains when that address is deleted.
      </p>

      <h2>Changes and availability</h2>
      <p>
        SnapList may update these terms as the product changes. If it does, the date at the top of
        this page changes. The service may be unavailable while it is being built, maintained, or
        updated.
      </p>

      <h2>Contact</h2>
      <SupportChannel context="support" />
    </section>
  );
}
