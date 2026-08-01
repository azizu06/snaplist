import { supportEmail } from "@/lib/marketing/site";

/**
 * The one place the support address is rendered.
 *
 * No support address exists in this repository — the v6 design carries the
 * destination as the inert token COMPANY_CONTACT_PENDING. Rather than hardcode a
 * guess, the address comes from NEXT_PUBLIC_SUPPORT_EMAIL. When it is unset the
 * page still renders and still says what to expect; it just cannot name a
 * channel yet. Setting the variable turns every instance into a real mailto:
 * with no code change.
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
