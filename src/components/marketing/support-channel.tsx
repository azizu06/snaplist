import { supportEmail } from "@/lib/marketing/site";

/**
 * The one place the support address is rendered.
 *
 * The address comes from NEXT_PUBLIC_SUPPORT_EMAIL — the v6 design carries the
 * destination as the inert token COMPANY_CONTACT_PENDING, and it stays env-driven
 * so each environment can point somewhere else with no code change. Production is
 * configured, so the deployed pages name a real address.
 *
 * `.env.example` is a template; nothing loads it at runtime. A checkout that sets
 * no environment of its own therefore still renders the notice below. What #953
 * changed is that the template no longer documents an empty value: the address it
 * names is one this component can actually render, so standing up an environment
 * is a copy rather than a hunt.
 *
 * The notice below is what an unset or unusable value renders: the page still
 * renders and still says what to expect, it just cannot name a channel.
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
