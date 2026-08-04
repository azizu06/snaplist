import type { Metadata } from "next";
import { SupportChannel } from "@/components/marketing/support-channel";

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
      <p>
        You keep your rights in the photos and optional voice context you provide. You give
        SnapList permission to process them only to identify your item, prepare an editable draft,
        find price evidence, and deliver the features you choose to use.
      </p>

      <h2>Your decisions</h2>
      <p>
        You review the listing, price, and condition before you use them. SnapList publishes to
        eBay only after your explicit confirmation. For Facebook Marketplace, Mercari, and Depop,
        SnapList prepares a handoff that you finish yourself.
      </p>

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
