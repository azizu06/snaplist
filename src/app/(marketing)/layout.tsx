import { getUserId } from "@/lib/auth";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

/**
 * (marketing) group layout — the public site chrome (issue #49). Always the
 * Darkroom night canvas regardless of OS color scheme; the signed-in state
 * only flips the nav CTA to "Open app".
 */
export default async function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const userId = await getUserId();

  return (
    <div className="flex min-h-screen flex-col bg-night text-flash">
      <MarketingNav signedIn={userId != null} />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
