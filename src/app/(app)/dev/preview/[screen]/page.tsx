import { notFound } from "next/navigation";
import {
  DashboardView,
  type DashboardRow,
} from "@/app/(app)/dashboard/dashboard-view";
import { ReviewView, type ReviewData } from "@/app/(app)/review/[itemId]/review-view";
import { UploadView } from "@/app/(app)/upload/upload-form";
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
    title: "Sony WH-1000XM4",
    status: "draft",
    createdAt: "2026-06-11T15:00:00Z",
    price: 178,
    costBasis: 60,
    thumbUrl: "/demo/headphones.jpg",
    category: "Electronics",
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
  photoUrls: ["/demo/headphones.jpg", "/demo/boombox.jpg"],
  identification: {
    label: "Sony WH-1000XM4 Wireless Headphones",
    confident: true,
    reason: null,
    candidates: [],
    evidence: 0.85,
  },
  attrs: [
    { key: "brand", value: "Sony" },
    { key: "model", value: "WH-1000XM4" },
    { key: "category", value: "Consumer electronics" },
    { key: "condition", value: "Good" },
    { key: "upc", value: "027242919623" },
    { key: "isbn", value: null },
  ],
  specs: ["wireless", "noise-cancelling", "over-ear"],
  listing: {
    id: "l-1",
    platform: "ebay",
    title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones, Black, Tested",
    description:
      "Sony's flagship noise-cancelling headphones in good working condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth.\n\nIncludes carry case and USB-C cable. Light wear on the headband padding (pictured). From a smoke-free home, tested and fully functional.",
    status: "draft",
  },
  suggested: 178,
  override: null,
  displayPrice: 178,
  costBasis: 60,
  measurements: null,
  range: { low: 155, high: 205 },
  confidence: 0.82,
  tier: "web_tight",
  sources: [
    {
      url: "https://www.ebay.com/itm/demo-1",
      title: "Sony WH-1000XM4 Black — sold listing",
      kind: "sold-comp",
    },
    {
      url: "https://www.mercari.com/us/item/demo-2",
      title: "Sony WH1000XM4 headphones (used)",
      kind: "asking-comp",
    },
    { url: "https://www.swappa.com/listing/demo-3", title: null, kind: "asking-comp" },
  ],
  strategies: [
    { key: "quick", label: "Quick sell", price: 167, blurb: "Priced to move — toward the lower end of real listed prices." },
    { key: "balanced", label: "Balanced", price: 178, blurb: "The typical listed price — a safe bet." },
    { key: "maximize", label: "Maximize", price: 194, blurb: "Top of what comparable items list for — expect a longer wait." },
  ],
  clarifyOptions: [
    { label: "Original carry case included", spec: "with carry case" },
    { label: "Ear pads in good condition", spec: "ear pads good condition" },
    { label: "Battery holds a full charge", spec: "battery holds full charge" },
    { label: "All buttons fully functional", spec: "all buttons functional" },
    { label: "Pairs reliably over Bluetooth", spec: "bluetooth pairs reliably" },
    { label: "Original box and USB-C cable", spec: "original box and cable" },
  ],
  banner: {
    variant: "warning",
    title: "Waiting for your review",
    detail:
      "Confidence was below the autopilot threshold when this listing was generated, so it waits for you.",
  },
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
  title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones, Black, Tested",
  description:
    "Sony's flagship noise-cancelling headphones in good working condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth.\n\nIncludes carry case and USB-C cable. Light wear on the headband padding (pictured). From a smoke-free home, tested and fully functional.",
  status: "draft",
  published: false,
  failed: false,
  ebayListingId: null,
  photoUrl: "/demo/headphones.jpg",
  actionError: null,
};

const FIXTURE_EXPORT: ExportData = {
  itemId: "fx-1",
  itemName: "Sony WH-1000XM4",
  itemThumb: "/demo/headphones.jpg",
  condition: "Good",
  price: 178,
  packs: {
    facebook: {
      title: "Sony WH-1000XM4 Wireless Headphones",
      description:
        "For sale: Sony WH-1000XM4 noise cancelling headphones in good condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth. Includes carry case and USB-C cable.",
      hashtags: [],
      copyBlock:
        "Sony WH-1000XM4 Wireless Headphones\n\nFor sale: Sony WH-1000XM4 noise cancelling headphones in good condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth. Includes carry case and USB-C cable.\n\nCondition: Good\nAsking $178\nLocal pickup, message me if interested!",
    },
    mercari: {
      title: "Sony WH-1000XM4 Noise Cancelling Headphones",
      description:
        "For sale: Sony WH-1000XM4 in good condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth. Includes carry case and USB-C cable. Shipping available.",
      hashtags: ["#sony", "#wh1000xm4", "#headphones"],
      copyBlock:
        "Sony WH-1000XM4 Noise Cancelling Headphones\n\nFor sale: Sony WH-1000XM4 in good condition. Industry-leading ANC, 30-hour battery, multipoint Bluetooth. Includes carry case and USB-C cable. Shipping available.\n\n#sony #wh1000xm4 #headphones",
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
      return <UploadView action={noopAction} actionError={null} />;
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
