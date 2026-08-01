import { notFound } from "next/navigation";
import {
  DashboardView,
  type DashboardRow,
} from "@/app/(app)/dashboard/dashboard-view";
import { ReviewView, type ReviewData } from "@/app/(app)/review/[itemId]/review-view";
import { BatchCaptureView } from "@/app/(app)/batch/batch-capture";
import {
  PublishView,
  type PublishData,
} from "@/app/(app)/listings/[listingId]/publish-view";
import {
  SettingsView,
  type SettingsData,
} from "@/app/(app)/settings/settings-view";
import { InboxEmptyState } from "@/app/(app)/inbox/inbox-empty";
import { InboxThreadPreview } from "../inbox-thread-preview";
import { ExportView, type ExportData } from "@/app/(app)/export/[itemId]/export-view";
import { UploadPreview } from "../upload-preview";

/**
 * DEV-ONLY visual preview harness (issue #40 round 2). Renders the
 * presentational views with fixture data so every screen can be screenshot-
 * iterated against the Mobbin references WITHOUT a running Supabase stack.
 * Hard-gated out of production builds.
 */

const FIXTURE_ROWS: DashboardRow[] = [
  {
    itemId: "fx-1",
    listingId: "l-1",
    title: "Sony PlayStation 5 bundle",
    status: "draft",
    createdAt: "2026-06-11T15:00:00Z",
    price: 379,
    costBasis: 245,
    thumbUrl: "/demo/reseller/ps5.webp",
    category: "Video games",
    condition: "Good",
  },
  {
    itemId: "fx-2",
    listingId: "l-2",
    title: "Nintendo Switch 2",
    status: "queued",
    createdAt: "2026-06-11T13:30:00Z",
    price: 415,
    costBasis: 330,
    thumbUrl: "/demo/reseller/switch-2.webp",
    category: "Video games",
    condition: "Fair",
  },
  {
    itemId: "fx-3",
    listingId: "l-3",
    title: "White Air Jordan sneakers",
    status: "published",
    createdAt: "2026-06-10T19:12:00Z",
    price: 110,
    costBasis: null,
    thumbUrl: "/demo/reseller/air-jordan-pair.webp",
    category: "Sneakers",
    condition: "Good",
  },
  {
    itemId: "fx-4",
    listingId: "l-4",
    title: "Sony mirrorless camera kit",
    status: "failed",
    createdAt: "2026-06-10T16:40:00Z",
    price: 895,
    costBasis: 620,
    thumbUrl: "/demo/reseller/camera.webp",
    category: "Electronics",
    condition: "Good",
  },
  {
    itemId: "fx-5",
    listingId: null,
    title: "Charizard Pokémon card",
    status: "new",
    createdAt: "2026-06-09T11:05:00Z",
    price: null,
    costBasis: 18,
    thumbUrl: "/demo/reseller/charizard.webp",
    category: "Collectibles",
    condition: "Good",
  },
  {
    itemId: "fx-6",
    listingId: "l-6",
    title: "iPhone 15",
    status: "archived",
    createdAt: "2026-06-08T09:00:00Z",
    price: 499,
    costBasis: 355,
    thumbUrl: "/demo/reseller/iphone-15.webp",
    category: "Cell phones",
    condition: "Good",
  },
];

const FIXTURE_REVIEW: ReviewData = {
  itemId: "fx-1",
  reviewRevision: "00000000-0000-4000-8000-000000000001",
  reviewBlocked: false,
  photoUrls: ["/demo/reseller/ps5.webp"],
  identification: {
    label: "Sony PlayStation 5 Console with DualSense Controller",
    confident: true,
    reason: null,
    candidates: [],
    evidence: 0.92,
  },
  attrs: [
    { key: "brand", value: "Sony" },
    { key: "model", value: "PlayStation 5" },
    { key: "category", value: "Video game consoles" },
    { key: "condition", value: "Good" },
    { key: "upc", value: null },
    { key: "isbn", value: null },
  ],
  specs: ["White-and-black console", "DualSense wireless controller", "Console and controller shown together"],
  listing: {
    id: "l-1",
    platform: "ebay",
    title: "Sony PlayStation 5 Console with DualSense Wireless Controller — White",
    description:
      "Sony PlayStation 5 console in good cosmetic condition with the matching white-and-black DualSense wireless controller shown in the photo.\n\nThe console and controller are pictured together. Please review the photo for the exact cosmetic condition and included items.",
    status: "draft",
  },
  suggested: 379,
  override: null,
  displayPrice: 379,
  costBasis: 245,
  measurements: null,
  range: { low: 340, high: 425 },
  confidence: 0.9,
  tier: "ebay-sold",
  sources: [
    {
      url: "https://www.ebay.com/itm/demo-sold-1",
      title: "Sony PlayStation 5 console with DualSense controller — sold",
      kind: "sold-comp",
    },
    {
      url: "https://www.ebay.com/itm/demo-sold-2",
      title: "PlayStation 5 console and controller bundle — sold",
      kind: "sold-comp",
    },
    {
      url: "https://www.ebay.com/itm/demo-sold-3",
      title: "Sony PS5 white console bundle — sold",
      kind: "sold-comp",
    },
  ],
  strategies: [
    { key: "quick", label: "Quick sell", price: 355, blurb: "Priced to move — toward the lower end of recent sold prices." },
    { key: "balanced", label: "Balanced", price: 379, blurb: "Centered on the recent sold-price cluster." },
    { key: "maximize", label: "Maximize", price: 409, blurb: "Near the top of comparable sold bundles." },
  ],
  clarifyOptions: [
    { label: "Power cable included", spec: "power cable included" },
    { label: "HDMI cable included", spec: "HDMI cable included" },
    { label: "Controller tested", spec: "DualSense controller tested" },
    { label: "Console powers on", spec: "console powers on" },
    { label: "Factory reset", spec: "factory reset completed" },
    { label: "Wi-Fi tested", spec: "Wi-Fi tested" },
  ],
  banner: null,
  actionError: null,
};

const FIXTURE_SETTINGS: SettingsData = {
  user: {
    name: "Aziz Umarov",
    email: "preview@snaplist.dev",
    imageUrl: null,
  },
  autopilotEnabled: true,
  autoReplyEnabled: false,
  ebay: { connected: true, ebayUsername: "aziz_resells" },
  billing: { tier: "free", itemsPerDay: 15, proItemsPerDay: 200, billingEnabled: true },
  error: null,
  ebayBanner: null,
};

const FIXTURE_PUBLISH: PublishData = {
  listingId: "l-1",
  itemId: "fx-1",
  platform: "ebay",
  title: "Sony PlayStation 5 Console with DualSense Wireless Controller — White",
  description:
    "Sony PlayStation 5 console in good cosmetic condition with the matching white-and-black DualSense wireless controller shown in the photo. Review the photo for the exact cosmetic condition and included items.",
  status: "draft",
  published: false,
  failed: false,
  ebayListingId: null,
  photoUrl: "/demo/reseller/ps5.webp",
  actionError: null,
};

const FIXTURE_EXPORT: ExportData = {
  itemId: "fx-1",
  itemName: "Sony PlayStation 5 bundle",
  itemThumb: "/demo/reseller/ps5.webp",
  condition: "Good",
  price: 379,
  packs: {
    facebook: {
      title: "Sony PlayStation 5 Console with DualSense Controller",
      description:
        "Sony PlayStation 5 console in good cosmetic condition with the white-and-black DualSense controller shown in the photo.",
      hashtags: [],
      price: 379,
      copyBlock:
        "Sony PlayStation 5 Console with DualSense Controller\n\nWhite-and-black PS5 console and matching controller shown together.\n\nCondition: Good\nAsking $379\nLocal pickup, message me if interested!",
    },
    mercari: {
      title: "Sony PlayStation 5 Console + DualSense Controller",
      description:
        "Sony PlayStation 5 console in good cosmetic condition with the matching white-and-black DualSense controller shown in the photo. Shipping available.",
      hashtags: ["#playstation5", "#ps5", "#gamingconsole"],
      price: 379,
      copyBlock:
        "Sony PlayStation 5 Console + DualSense Controller\n\nWhite-and-black PS5 console and matching controller shown together. Shipping available.\n\n#playstation5 #ps5 #gamingconsole",
    },
    // Depop carries no title — its form has no title field (issue #378).
    depop: {
      description:
        "Sony PlayStation 5. Condition: Good. Details: white-and-black DualSense controller included.",
      hashtags: ["#sony", "#playstation5", "#ps5"],
      price: 379,
      copyBlock:
        "Sony PlayStation 5. Condition: Good. Details: white-and-black DualSense controller included.\n\n#sony #playstation5 #ps5",
    },
    cached: true,
    model: "gemini-2.5-flash",
  },
  error: null,
};

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ screen: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { screen } = await params;

  async function noopAction() {
    "use server";
  }
  async function noopIds() {
    "use server";
  }
  async function noopBulk() {
    "use server";
  }

  switch (screen) {
    case "dashboard":
      return (
        <DashboardView
          rows={FIXTURE_ROWS}
          counts={{ draft: 1, attention: 1, live: 1 }}
          filter="all"
          archiveAction={noopIds}
          unarchiveAction={noopIds}
          deleteAction={noopIds}
          bulkUpdateAction={noopBulk}
        />
      );
    case "dashboard-empty":
      return (
        <DashboardView rows={[]} counts={{ draft: 0, attention: 0, live: 0 }} filter="all" />
      );
    case "review":
      return (
        <ReviewView
          data={FIXTURE_REVIEW}
          saveAction={noopAction}
          sharpenAction={noopAction}
          regenerateAction={noopAction}
        />
      );
    case "export":
      return <ExportView data={FIXTURE_EXPORT} />;
    case "settings":
      return (
        <SettingsView
          data={FIXTURE_SETTINGS}
          autopilotAction={noopAction}
          autoReplyAction={noopAction}
          disconnectEbayAction={noopAction}
        />
      );
    case "settings-disconnected":
      return (
        <SettingsView
          data={{
            ...FIXTURE_SETTINGS,
            autopilotEnabled: false,
            autoReplyEnabled: false,
            ebay: { connected: false, ebayUsername: null },
          }}
          autopilotAction={noopAction}
          autoReplyAction={noopAction}
          disconnectEbayAction={noopAction}
        />
      );
    case "inbox-empty":
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
          <header>
            <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
              Buyer inbox
            </h1>
            <p className="mt-0.5 text-[14px] text-muted">
              Questions from buyers appear here live. We draft a reply from the
              listing, then you approve or edit before anything sends.
            </p>
          </header>
          <section className="flex flex-col gap-3">
            <h2 className="text-[14px] font-semibold text-fg-strong">Messages</h2>
            <InboxEmptyState />
          </section>
        </main>
      );
    case "inbox-thread":
      // The replied-state thread → mounts the follow-up composer + header, so
      // the attach-menu / send-button / avatar can be screenshot-iterated.
      return (
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
          <InboxThreadPreview />
        </main>
      );
    case "upload":
      return <UploadPreview action={noopAction} />;
    case "batch":
      return <BatchCaptureView />;
    case "publish":
      return <PublishView data={FIXTURE_PUBLISH} publishAction={noopAction} />;
    case "publish-live":
      return (
        <PublishView
          data={{
            ...FIXTURE_PUBLISH,
            status: "published",
            published: true,
            ebayListingId: "110586744102",
          }}
          publishAction={noopAction}
        />
      );
    case "publish-failed":
      return (
        <PublishView
          data={{ ...FIXTURE_PUBLISH, status: "failed", failed: true }}
          publishAction={noopAction}
        />
      );
    case "review-uncertain":
      return (
        <ReviewView
          data={{
            ...FIXTURE_REVIEW,
            identification: {
              label: "Bluetooth over-ear headphones",
              confident: false,
              reason:
                "No clear brand markings were visible in the photos, and several models share this design.",
              candidates: ["Sony WH-CH720N", "Anker Soundcore Q45", "JBL Tune 770NC"],
              evidence: 0.35,
            },
            confidence: 0.41,
            tier: "llm_only",
            suggested: 45,
            displayPrice: 45,
            range: { low: 30, high: 70 },
            // llm-only / low confidence → a single honest point, no fabricated split.
            strategies: [
              {
                key: "balanced",
                label: "Suggested",
                price: 45,
                blurb:
                  "Our best estimate — not enough comparable sales for quick / maximize options.",
              },
            ],
          }}
          saveAction={noopAction}
          sharpenAction={noopAction}
          regenerateAction={noopAction}
        />
      );
    case "review-sharpen":
      // Mid-confidence, comp-backed item: shows BOTH new features at once — the
      // quick/balanced/maximize selector AND the dynamic "Confirm what applies" chips.
      return (
        <ReviewView
          data={{ ...FIXTURE_REVIEW, confidence: 0.68, tier: "web_wide" }}
          saveAction={noopAction}
          sharpenAction={noopAction}
          regenerateAction={noopAction}
        />
      );
    default:
      notFound();
  }
}
