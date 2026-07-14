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
    title: "Acer Predator Helios 300",
    status: "draft",
    createdAt: "2026-06-11T15:00:00Z",
    price: 550,
    costBasis: 310,
    thumbUrl: "/demo/authentic/acer-predator-a1-open.jpg",
    category: "Computers",
    condition: "Good",
  },
  {
    itemId: "fx-2",
    listingId: "l-2",
    title: "Nintendo Game Boy Color",
    status: "queued",
    createdAt: "2026-06-11T13:30:00Z",
    price: 112,
    costBasis: 25,
    thumbUrl: "/demo/gameboy.jpg",
    category: "Video games",
    condition: "Fair",
  },
  {
    itemId: "fx-3",
    listingId: "l-3",
    title: "Patagonia Better Sweater Fleece",
    status: "published",
    createdAt: "2026-06-10T19:12:00Z",
    price: 64,
    costBasis: null,
    thumbUrl: "/demo/jacket.jpg",
    category: "Apparel",
    condition: "Like new",
  },
  {
    itemId: "fx-4",
    listingId: "l-4",
    title: "Canon EOS 80D",
    status: "failed",
    createdAt: "2026-06-10T16:40:00Z",
    price: 429,
    costBasis: 300,
    thumbUrl: "/demo/camera.jpg",
    category: "Electronics",
    condition: "Good",
  },
  {
    itemId: "fx-5",
    listingId: null,
    title: "The Pragmatic Programmer",
    status: "new",
    createdAt: "2026-06-09T11:05:00Z",
    price: null,
    costBasis: 4,
    thumbUrl: null,
    category: "Books",
    condition: "Like new",
  },
  {
    itemId: "fx-6",
    listingId: "l-6",
    title: "KitchenAid Artisan Stand Mixer",
    status: "archived",
    createdAt: "2026-06-08T09:00:00Z",
    price: 220,
    costBasis: 90,
    thumbUrl: null,
    category: "Home & kitchen",
    condition: "Good",
  },
];

const FIXTURE_REVIEW: ReviewData = {
  itemId: "fx-1",
  reviewRevision: "00000000-0000-4000-8000-000000000001",
  reviewBlocked: false,
  photoUrls: [
    "/demo/authentic/acer-predator-a1-open.jpg",
    "/demo/authentic/acer-predator-a2-night.jpg",
    "/demo/authentic/acer-predator-a3-closed.jpg",
    "/demo/authentic/acer-predator-a4-boot.jpg",
  ],
  identification: {
    label: "Acer Predator Helios 300 Gaming Laptop",
    confident: true,
    reason: null,
    candidates: [],
    evidence: 0.85,
  },
  attrs: [
    { key: "brand", value: "Acer" },
    { key: "model", value: "Predator Helios 300" },
    { key: "category", value: "Computers & laptops" },
    { key: "condition", value: "Good" },
    { key: "upc", value: null },
    { key: "isbn", value: null },
  ],
  specs: ["Intel Core i7", "GeForce RTX graphics", "144Hz display", "RGB keyboard"],
  listing: {
    id: "l-1",
    platform: "ebay",
    title: "Acer Predator Helios 300 Gaming Laptop Core i7 RTX 144Hz, Tested",
    description:
      "Acer Predator Helios 300 gaming laptop in good working condition. The visible badges identify an Intel Core i7 configuration with GeForce RTX graphics and a 144Hz display.\n\nRGB keyboard, screen, ports, and boot state are pictured. Includes the original charger. Light cosmetic wear from normal use; tested and fully functional.",
    status: "draft",
  },
  suggested: 550,
  override: null,
  displayPrice: 550,
  costBasis: 310,
  measurements: null,
  range: { low: 495, high: 625 },
  confidence: 0.88,
  tier: "ebay-sold",
  sources: [
    {
      url: "https://www.ebay.com/itm/demo-sold-1",
      title: "Acer Predator Helios 300 RTX gaming laptop — sold",
      kind: "sold-comp",
    },
    {
      url: "https://www.ebay.com/itm/demo-sold-2",
      title: "Predator Helios 300 Core i7 144Hz — sold",
      kind: "sold-comp",
    },
    {
      url: "https://www.ebay.com/itm/demo-sold-3",
      title: "Acer Helios gaming notebook with charger — sold",
      kind: "sold-comp",
    },
  ],
  strategies: [
    { key: "quick", label: "Quick sell", price: 515, blurb: "Priced to move — toward the lower end of recent sold prices." },
    { key: "balanced", label: "Balanced", price: 550, blurb: "Centered on the recent sold-price cluster." },
    { key: "maximize", label: "Maximize", price: 595, blurb: "Near the top of comparable sold configurations." },
  ],
  clarifyOptions: [
    { label: "Original charger included", spec: "original charger included" },
    { label: "Battery holds a charge", spec: "battery holds a charge" },
    { label: "144Hz display works", spec: "144Hz display tested" },
    { label: "RGB keyboard works", spec: "RGB keyboard tested" },
    { label: "All ports tested", spec: "all ports tested" },
    { label: "Fresh Windows install", spec: "fresh Windows install" },
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
  ebay: { connected: true, ebayUsername: "aziz_resells" },
  billing: { tier: "free", itemsPerDay: 15, proItemsPerDay: 200, billingEnabled: true },
  error: null,
  ebayBanner: null,
};

const FIXTURE_PUBLISH: PublishData = {
  listingId: "l-1",
  itemId: "fx-1",
  platform: "ebay",
  title: "Acer Predator Helios 300 Gaming Laptop Core i7 RTX 144Hz, Tested",
  description:
    "Acer Predator Helios 300 gaming laptop in good working condition. Intel Core i7, GeForce RTX graphics, 144Hz display, and RGB keyboard are shown in the photos. Includes original charger. Light cosmetic wear; tested and fully functional.",
  status: "draft",
  published: false,
  failed: false,
  ebayListingId: null,
  photoUrl: "/demo/authentic/acer-predator-a1-open.jpg",
  actionError: null,
};

const FIXTURE_EXPORT: ExportData = {
  itemId: "fx-1",
  itemName: "Acer Predator Helios 300",
  itemThumb: "/demo/authentic/acer-predator-a1-open.jpg",
  condition: "Good",
  price: 550,
  packs: {
    facebook: {
      title: "Acer Predator Helios 300 Gaming Laptop",
      description:
        "Acer Predator Helios 300 gaming laptop in good condition. Core i7, GeForce RTX graphics, 144Hz display, and RGB keyboard. Original charger included.",
      hashtags: [],
      price: 550,
      copyBlock:
        "Acer Predator Helios 300 Gaming Laptop\n\nCore i7, GeForce RTX graphics, 144Hz display, and RGB keyboard. Original charger included.\n\nCondition: Good\nAsking $550\nLocal pickup, message me if interested!",
    },
    mercari: {
      title: "Acer Predator Helios 300 Gaming Laptop",
      description:
        "Acer Predator Helios 300 in good condition with Core i7, GeForce RTX graphics, a 144Hz display, and RGB keyboard. Charger included. Shipping available.",
      hashtags: ["#acerpredator", "#gaminglaptop", "#pcgaming"],
      price: 550,
      copyBlock:
        "Acer Predator Helios 300 Gaming Laptop\n\nCore i7, GeForce RTX graphics, 144Hz display, and RGB keyboard. Original charger included. Shipping available.\n\n#acerpredator #gaminglaptop #pcgaming",
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
          disconnectEbayAction={noopAction}
        />
      );
    case "settings-disconnected":
      return (
        <SettingsView
          data={{
            ...FIXTURE_SETTINGS,
            autopilotEnabled: false,
            ebay: { connected: false, ebayUsername: null },
          }}
          autopilotAction={noopAction}
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
