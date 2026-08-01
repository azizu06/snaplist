import type { Metadata } from "next";
import { SupportChannel } from "@/components/marketing/support-channel";

/**
 * Privacy policy.
 *
 * App Review requires a resolvable privacy URL before submission, and no such
 * page existed in this repository — the v6 design carries the destination as the
 * inert token LEGAL_PRIVACY_PENDING.
 *
 * Every retention claim below is taken from the repository's own normative
 * authority (`docs/contracts/lean-mvp-retention-v1.json`, explained by ADR-0012)
 * rather than written as boilerplate, so the page cannot promise a deletion the
 * product does not perform. Where a record belongs to a provider rather than to
 * SnapList, the page says so instead of claiming SnapList deletes it — that
 * distinction is the contract's, not a hedge.
 */
export const metadata: Metadata = {
  title: "Privacy Policy — SnapList",
  description:
    "What SnapList collects, how long it is kept, who processes it, and how to delete it.",
};

export default function PrivacyPage() {
  return (
    <section className="mkt-shell mkt-shell--prose mkt-doc">
      <h1>Privacy Policy</h1>
      <p className="mkt-doc__meta">Last updated 1 August 2026</p>

      <p>
        SnapList turns photos of an item into an editable listing. This page describes what the
        app collects to do that, how long each thing is kept, who else processes it, and how to
        have it deleted.
      </p>

      <h2>What SnapList collects</h2>
      <ul>
        <li>
          <strong>Item photos.</strong> The one to five photos you take for each item, and the
          order you put them in.
        </li>
        <li>
          <strong>Voice context, if you record it.</strong> One optional voice note of at most
          fifteen seconds. It is treated as your description of the item, not as verified fact
          about it.
        </li>
        <li>
          <strong>The listing SnapList drafts.</strong> Title, condition, item details,
          description, price, and the sold-price evidence behind the recommendation.
        </li>
        <li>
          <strong>Account identity.</strong> Your sign-in identity, once you create an account.
        </li>
        <li>
          <strong>Subscription status.</strong> Whether a SnapList Pro subscription is active. The
          payment itself is handled by Apple; SnapList never sees your card.
        </li>
        <li>
          <strong>Diagnostics.</strong> Crash reports and processing telemetry, with the contents
          of your listings removed before they are sent.
        </li>
      </ul>

      <h2>How long it is kept</h2>
      <ul>
        <li>
          <strong>Raw voice recordings are temporary.</strong> The audio is deleted once it has
          been transcribed, and never later than 24 hours after SnapList accepts the item. Only
          the short text transcript is kept, and it is deleted with the item.
        </li>
        <li>
          <strong>A result created before you sign up lasts 24 hours.</strong> If you use SnapList
          without an account, the listing it produces stays available for 24 hours so you can come
          back and claim it. After that it is deleted.
        </li>
        <li>
          <strong>Photos and listings last as long as the item does.</strong> Deleting an item
          deletes its photos, its draft, its export packs, and its pricing evidence.
        </li>
        <li>
          <strong>Operational records are capped at 30 days.</strong> Processing metadata that is
          not part of your listing is discarded after 30 days at the latest, and sooner if you
          delete the item or your account.
        </li>
      </ul>

      <h2>Who else processes it</h2>
      <p>
        SnapList uses these services to do its work. Each receives only what that job needs.
      </p>
      <ul>
        <li>
          <strong>Clerk</strong> — account sign-in and identity.
        </li>
        <li>
          <strong>Supabase</strong> — the database and the private storage your photos are kept
          in. Storage is private; photos are not published to the web by SnapList.
        </li>
        <li>
          <strong>OpenAI and Google</strong> — the models that read the photos, transcribe the
          voice note, and draft the listing text.
        </li>
        <li>
          <strong>Web search and sold-comp providers</strong> — these receive a description of the
          item in order to look up comparable sold listings. They do not receive your identity.
        </li>
        <li>
          <strong>eBay</strong> — only when you confirm a publish, and only through your own
          connected eBay account.
        </li>
        <li>
          <strong>Apple and RevenueCat</strong> — subscription purchase and status.
        </li>
        <li>
          <strong>Sentry</strong> — crash reporting, with listing contents scrubbed.
        </li>
      </ul>

      <div className="mkt-doc__note">
        <p style={{ margin: 0 }}>
          Some records belong to those providers rather than to SnapList. A listing you published
          to eBay is an eBay record, and a purchase is an Apple record. Deleting your SnapList
          account removes SnapList&apos;s copy and its references; it does not delete the eBay
          listing or the Apple purchase, which you manage in those accounts.
        </p>
      </div>

      <h2>Deleting your data</h2>
      <p>
        You can delete an individual item from the app, which deletes its photos, transcript,
        draft, export packs, and pricing evidence. You can also delete your account, which removes
        your items and your sign-in identity. Account deletion is not reported as complete until
        every record it covers has actually been removed.
      </p>

      <h2>Children</h2>
      <p>SnapList is not directed to children under 13 and does not knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>
        If this policy changes, the date at the top of this page changes with it.
      </p>

      <h2>Contact</h2>
      <SupportChannel context="privacy" />
    </section>
  );
}
