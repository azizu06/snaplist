import { supportEmail } from "@/lib/marketing/site";

/**
 * The one place the support address is rendered.
 *
 * The address comes from NEXT_PUBLIC_SUPPORT_EMAIL — the v6 design carried the
 * destination as the inert token COMPANY_CONTACT_PENDING, and it stays
 * env-driven so each environment can point somewhere else with no code change.
 * `.env.example` carries the published address, so an unconfigured checkout
 * renders the real one rather than the notice below (#953).
 *
 * The notice below is what remains when the variable is set to something
 * unusable: the page still renders and still says what to expect, it just
 * cannot name a channel.
 *
 * The unresolved state is deliberately not a `mailto:` with a placeholder
 * address: that would look like a working contact route and silently drop every
 * message sent to it.
 */
export function SupportChannel({ context }: { context: "privacy" | "support" }) {
  const email = supportEmail();

  if (!email) {
    return (
      <p>
        A published support address is not live yet. It will appear here and in the App Store
        listing before SnapList is available to download.
      </p>
    );
  }

  return (
    <p>
      {context === "privacy"
        ? "Questions about this policy, or a request to delete your data: "
        : "Email us and a person will read it: "}
      <a href={`mailto:${email}`}>{email}</a>
    </p>
  );
}
