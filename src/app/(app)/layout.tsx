import { currentUser } from "@clerk/nextjs/server";
import { getUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listRecentNotifications, type NotificationView } from "@/lib/notifications";
import { AppShell } from "@/components/app-shell";
import { UploadDraftProvider } from "./upload/upload-draft-context";
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
// Mirror the dashboard rows exactly: the SAME compact "brand + model" name and
// first-photo thumbnail a list row shows — never the long eBay SEO title — so a
// search result reads identically to the row it links to.
const PREVIEW_SEARCH_FIXTURES: PaletteHit[] = [
  { itemId: "fx-1", title: "Sony PlayStation 5 bundle", status: "draft", thumbUrl: "/demo/reseller/ps5.webp", createdAt: "2026-06-11T15:00:00Z" },
  { itemId: "fx-2", title: "Nintendo Switch 2", status: "queued", thumbUrl: "/demo/reseller/switch-2.webp", createdAt: "2026-06-11T13:30:00Z" },
  { itemId: "fx-3", title: "White Air Jordan sneakers", status: "published", thumbUrl: "/demo/reseller/air-jordan-pair.webp", createdAt: "2026-06-10T19:12:00Z" },
  { itemId: "fx-4", title: "Sony mirrorless camera kit", status: "failed", thumbUrl: "/demo/reseller/camera.webp", createdAt: "2026-06-10T16:40:00Z" },
  { itemId: "fx-5", title: "Charizard Pokémon card", status: "new", thumbUrl: "/demo/reseller/charizard.webp", createdAt: "2026-06-09T11:05:00Z" },
];
const PREVIEW_NOTIFICATIONS: NotificationView[] = [
  { id: "n-1", kind: "buyer_message", title: "New question on Sony PlayStation 5 bundle", body: "“Does the pictured controller come with it?” — a reply is drafted for you.", href: "/inbox", read: false, createdAt: "2026-06-16T14:10:00Z" },
  { id: "n-2", kind: "listing_published", title: "White Air Jordan sneakers are live on eBay", body: "Listed at $110. You can view or edit them anytime.", href: "/dashboard", read: false, createdAt: "2026-06-16T11:32:00Z" },
  { id: "n-3", kind: "listing_failed", title: "Couldn’t publish the Sony camera kit", body: "eBay rejected the listing — add a price and try again.", href: "/dashboard", read: true, createdAt: "2026-06-15T18:05:00Z" },
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
  let notifications: NotificationView[] = [];
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
    // RLS scopes the read to this user; the bell rides Realtime from here.
    const supabase = await createClient();
    notifications = await listRecentNotifications(supabase);
  } else if (previewSignedIn) {
    user = PREVIEW_USER;
    notifications = PREVIEW_NOTIFICATIONS;
  }

  return (
    <AppShell
      signedIn={userId != null || previewSignedIn}
      user={user}
      userId={userId}
      notifications={notifications}
      searchFixtures={
        previewSignedIn && !userId ? PREVIEW_SEARCH_FIXTURES : undefined
      }
    >
      {/* Holds pending upload photos so a half-built listing survives in-app
          navigation (Home/inbox and back). Lives in the layout, which persists
          across (app) route changes. */}
      <UploadDraftProvider>{children}</UploadDraftProvider>
    </AppShell>
  );
}
