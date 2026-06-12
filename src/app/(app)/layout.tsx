import { getUserId } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

/**
 * (app) group layout — the signed-in product shell (moved out of the root
 * layout in issue #49 so marketing pages own their separate chrome).
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const userId = await getUserId();

  // Dev-only: the screenshot preview harness (src/app/(app)/dev/preview) needs
  // the signed-in chrome without a running auth stack. Never true in production.
  const previewSignedIn =
    process.env.NODE_ENV !== "production" &&
    process.env.PREVIEW_SIGNED_IN === "1";

  return (
    <AppShell signedIn={userId != null || previewSignedIn}>{children}</AppShell>
  );
}
