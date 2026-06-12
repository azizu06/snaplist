import { currentUser } from "@clerk/nextjs/server";
import { getUserId } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import type { ProfileUser } from "@/components/profile-menu";
import type { PaletteHit } from "@/components/command-palette";

/**
 * (app) group layout — the signed-in product shell (moved out of the root
 * layout in issue #49 so marketing pages own their separate chrome).
 * Dashboard v2: resolves the Clerk profile here so the shell's account
 * dropdown gets plain serializable fields, never a client Clerk dependency.
 */

/** Dev-preview stand-ins so the chrome (avatar, ⌘K results) is screenshotable
 * without an auth stack. Mirrors the dashboard preview fixtures. */
const PREVIEW_USER: ProfileUser = {
  name: "Aziz Umarov",
  email: "preview@snaplist.dev",
  imageUrl: null,
};
const PREVIEW_SEARCH_FIXTURES: PaletteHit[] = [
  { itemId: "fx-1", title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones", status: "draft", createdAt: "2026-06-11T15:00:00Z" },
  { itemId: "fx-2", title: "LEGO Star Wars Millennium Falcon 75257 — complete in box", status: "queued", createdAt: "2026-06-11T13:30:00Z" },
  { itemId: "fx-3", title: "Patagonia Better Sweater Fleece Jacket, Men's M", status: "published", createdAt: "2026-06-10T19:12:00Z" },
  { itemId: "fx-4", title: "KitchenAid Artisan Stand Mixer 5-qt, Empire Red", status: "failed", createdAt: "2026-06-10T16:40:00Z" },
  { itemId: "fx-5", title: "The Pragmatic Programmer (20th Anniversary, hardcover)", status: "new", createdAt: "2026-06-09T11:05:00Z" },
];

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

  let user: ProfileUser | null = null;
  if (userId) {
    const clerkUser = await currentUser();
    user = {
      name:
        clerkUser?.fullName ??
        clerkUser?.username ??
        clerkUser?.primaryEmailAddress?.emailAddress ??
        "Account",
      email: clerkUser?.primaryEmailAddress?.emailAddress ?? "",
      imageUrl: clerkUser?.imageUrl ?? null,
    };
  } else if (previewSignedIn) {
    user = PREVIEW_USER;
  }

  return (
    <AppShell
      signedIn={userId != null || previewSignedIn}
      user={user}
      searchFixtures={
        previewSignedIn && !userId ? PREVIEW_SEARCH_FIXTURES : undefined
      }
    >
      {children}
    </AppShell>
  );
}
