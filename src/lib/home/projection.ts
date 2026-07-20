import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  assembleDashboardRows,
  latestPricePerItem,
  type DashboardItemSource,
  type DashboardListingSource,
} from "@/lib/dashboard/rows";
import {
  PIPELINE_PROGRESS_SELECT,
  pipelineProgressRunSchema,
  type PipelineProgressRun,
} from "@/lib/pipeline-progress";

const uuid = z.string().uuid();
const homeDestinationSchema = z
  .object({
    kind: z.enum(["order", "conversation", "publishIssue", "draft"]),
    id: uuid,
  })
  .strict();

export const homeProjectionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sellerState: z.enum(["active", "newSeller"]),
    unreadNotificationCount: z.number().int().nonnegative(),
    summary: z
      .object({
        active: z.number().int().nonnegative(),
        drafts: z.number().int().nonnegative(),
        orders: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    attention: z.array(
      z
        .object({
          id: uuid,
          itemTitle: z.string().min(1),
          kind: z.enum(["shipping", "message", "offer", "warning", "pricing"]),
          status: z.string().min(1),
          detail: z.string().min(1),
          actionLabel: z.string().min(1),
          destination: homeDestinationSchema,
        })
        .strict(),
    ),
    currentRun: z
      .object({
        id: uuid,
        itemTitle: z.string().min(1),
        stageLabel: z.string().min(1),
        reassurance: z.string().min(1),
        progress: z.number().min(0).max(1).nullable(),
      })
      .strict()
      .nullable(),
    readyToFinish: z.array(
      z.object({ id: uuid, title: z.string().min(1), detail: z.string().min(1) }).strict(),
    ),
    listings: z.array(
      z
        .object({
          id: uuid,
          title: z.string().min(1),
          lifecycle: z.enum([
            "active",
            "draft",
            "sold",
            "needsAttention",
            "resolvedConversation",
          ]),
          statusLabel: z.string().min(1),
          detail: z.string().min(1),
          price: z.string().min(1).nullable(),
          destination: homeDestinationSchema.nullable(),
        })
        .strict(),
    ),
    recentSearches: z.array(z.string().min(1)),
  })
  .strict();

export type HomeProjection = z.infer<typeof homeProjectionSchema>;

export interface HomeProjectionReader {
  forSeller(input: { userId: string; bearerToken: string }): Promise<HomeProjection>;
}

interface HomeNotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  item_id: string | null;
  listing_id: string | null;
  source_message_id: string | null;
  read_at: string | null;
  created_at: string;
}

interface HomeItemRow extends DashboardItemSource {
  id: string;
  user_id: string;
  updated_at: string;
}

interface HomeListingRow extends DashboardListingSource {
  id: string;
  user_id: string;
  item_id: string;
  updated_at: string;
}

interface HomePredictionRow {
  id: string;
  user_id: string;
  item_id: string;
  price: unknown;
  created_at: string;
}

interface HomeMessageRootRow {
  id: string;
  user_id: string;
  item_id: string | null;
  listing_id: string | null;
  direction: string;
  marketplace: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface HomeMessageReplyRow {
  id: string;
  user_id: string;
  reply_to: string | null;
  direction: string;
  reply_kind: string | null;
  marketplace: string;
  delivery_status: string | null;
  external_delivery_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface HomeProjectionRows {
  notifications: HomeNotificationRow[];
  unreadNotificationCount: number;
  activeListingCount: number;
  draftListingCount: number;
  runs: PipelineProgressRun[];
  listings: HomeListingRow[];
  items: HomeItemRow[];
  predictions: HomePredictionRow[];
  messageRoots?: HomeMessageRootRow[];
  messageReplies?: HomeMessageReplyRow[];
  now?: Date;
  historyRevisionAt?: string | null;
}

const homeCurrentItemProjectionSchema = z
  .object({
    history_revision_at: z.string().datetime({ offset: true }).nullable(),
    listings: z.array(
      z
        .object({
          id: uuid,
          user_id: z.string().min(1),
          item_id: uuid,
          title: z.string().nullable(),
          status: z.string().min(1),
          created_at: z.string().datetime({ offset: true }),
          updated_at: z.string().datetime({ offset: true }),
          listed_price: z.unknown(),
        })
        .strict(),
    ),
    items: z.array(
      z
        .object({
          id: uuid,
          user_id: z.string().min(1),
          attributes: z.unknown(),
          photos: z.array(z.string()),
          price_override: z.unknown(),
          cost_basis: z.unknown(),
          created_at: z.string().datetime({ offset: true }),
          updated_at: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    predictions: z.array(
      z
        .object({
          id: uuid,
          user_id: z.string().min(1),
          item_id: uuid,
          price: z.unknown(),
          created_at: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict();

function money(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

const HOME_MESSAGE_PREVIEW_CODEPOINTS = 120;

function messagePreview(body: string): string | null {
  const normalized = body.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  const codepoints = Array.from(normalized);
  if (codepoints.length <= HOME_MESSAGE_PREVIEW_CODEPOINTS) return normalized;
  return `${codepoints.slice(0, HOME_MESSAGE_PREVIEW_CODEPOINTS - 1).join("")}…`;
}

function marketplaceLabel(marketplace: string): string | null {
  switch (marketplace) {
    case "ebay":
      return "eBay";
    case "simulated":
      return "Simulated";
    default:
      return null;
  }
}

function replyTimeLabel(sentAt: string, now: Date): string | null {
  const sentAtMilliseconds = Date.parse(sentAt);
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(sentAtMilliseconds) || !Number.isFinite(nowMilliseconds)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMilliseconds - sentAtMilliseconds) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(sentAtMilliseconds));
}

function listingPresentation(status: string): Pick<HomeProjection["listings"][number], "lifecycle" | "statusLabel" | "detail"> {
  switch (status) {
    case "published":
      return { lifecycle: "active", statusLabel: "Live", detail: "eBay · Live" };
    case "sold":
      return { lifecycle: "sold", statusLabel: "Sold", detail: "eBay · Sold" };
    case "failed":
    case "draft_failed":
      return {
        lifecycle: "needsAttention",
        statusLabel: "Needs attention",
        detail: "Listing preparation needs review",
      };
    case "new":
    case "queued":
      return { lifecycle: "draft", statusLabel: "Preparing", detail: "SnapList · In progress" };
    default:
      return { lifecycle: "draft", statusLabel: "Draft", detail: "Draft · Finish details" };
  }
}

function stagePresentation(stage: PipelineProgressRun["stage"]): string {
  switch (stage) {
    case "queued":
      return "Waiting to start";
    case "identifying":
      return "Identifying your item";
    case "pricing":
      return "Finding recent sold comps";
    case "generating":
      return "Writing your listing";
    case "persisting":
      return "Saving your draft";
    case "completed":
      return "Draft ready";
  }
}

function timestampRevision(rows: HomeProjectionRows): number {
  const timestamps = [
    ...(rows.historyRevisionAt ? [rows.historyRevisionAt] : []),
    ...rows.notifications.map((row) => row.created_at),
    ...rows.runs.map((row) => row.updated_at),
    ...rows.listings.flatMap((row) => [row.created_at as string, row.updated_at]),
    ...rows.items.flatMap((row) => [row.created_at as string, row.updated_at]),
    ...rows.predictions.map((row) => row.created_at),
    ...(rows.messageRoots ?? []).flatMap((row) => [row.created_at, row.updated_at]),
    ...(rows.messageReplies ?? []).flatMap((row) => [row.created_at, row.updated_at]),
  ];
  return timestamps.reduce((latest, value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
}

export function assembleHomeProjection(rows: HomeProjectionRows): HomeProjection {
  const dashboardRows = assembleDashboardRows({
    listings: rows.listings,
    items: rows.items,
    latestPrice: latestPricePerItem(rows.predictions),
    thumbUrlFor: () => null,
  });
  const listingRows = dashboardRows
    .filter((row) => row.status !== "archived")
    .map((row) => ({
      id: row.itemId,
      title: row.title,
      ...listingPresentation(row.status),
      price: money(row.price),
      destination: null,
    }));
  const dashboardRowsByItem = new Map(dashboardRows.map((row) => [row.itemId, row]));
  const messageRootsByID = new Map(
    (rows.messageRoots ?? []).map((message) => [message.id, message]),
  );
  const newestDeliveredReplyByRoot = new Map<string, HomeMessageReplyRow>();
  for (const reply of rows.messageReplies ?? []) {
    if (
      !reply.reply_to ||
      reply.direction !== "outbound" ||
      (reply.reply_kind !== null && reply.reply_kind !== "reply") ||
      reply.delivery_status !== "delivered" ||
      !reply.sent_at
    ) {
      continue;
    }
    const root = messageRootsByID.get(reply.reply_to);
    if (
      !root ||
      reply.user_id !== root.user_id ||
      reply.marketplace !== root.marketplace ||
      (reply.marketplace === "ebay" && !reply.external_delivery_id)
    ) {
      continue;
    }
    const existing = newestDeliveredReplyByRoot.get(root.id);
    if (!existing?.sent_at || Date.parse(reply.sent_at) > Date.parse(existing.sent_at)) {
      newestDeliveredReplyByRoot.set(root.id, reply);
    }
  }
  const seenBuyerRoots = new Set<string>();
  const actionableBuyerRoots = new Set<string>();
  const buyerRows = rows.notifications.flatMap<HomeProjection["listings"][number]>((notification) => {
    if (
      notification.kind !== "buyer_message" ||
      !notification.source_message_id ||
      seenBuyerRoots.has(notification.source_message_id)
    ) {
      return [];
    }
    const root = messageRootsByID.get(notification.source_message_id);
    const item = root?.item_id ? dashboardRowsByItem.get(root.item_id) : undefined;
    const marketplace = root ? marketplaceLabel(root.marketplace) : null;
    const preview = root ? messagePreview(root.body) : null;
    if (
      !root ||
      root.user_id !== notification.user_id ||
      root.direction !== "inbound" ||
      root.status === "externally_answered" ||
      root.status === "provider_unavailable" ||
      !item ||
      !marketplace ||
      !preview
    ) {
      return [];
    }
    const deliveredReply = newestDeliveredReplyByRoot.get(root.id);
    const repliedAt = deliveredReply?.sent_at
      ? replyTimeLabel(deliveredReply.sent_at, rows.now ?? new Date())
      : null;
    if (!repliedAt) actionableBuyerRoots.add(root.id);
    seenBuyerRoots.add(root.id);
    return [
      {
        id: root.id,
        title: item.title,
        lifecycle: repliedAt ? ("resolvedConversation" as const) : ("needsAttention" as const),
        statusLabel: repliedAt ? "Replied" : "Buyer question",
        detail: repliedAt
          ? `${marketplace} · You replied ${repliedAt}`
          : `${marketplace} · “${preview}”`,
        price: money(item.price),
        destination: { kind: "conversation" as const, id: root.id },
      },
    ];
  });
  const listings = [...listingRows, ...buyerRows];
  const activeRun = rows.runs.find((run) =>
    ["queued", "running", "retrying"].includes(run.status),
  );
  const itemTitles = new Map(dashboardRows.map((row) => [row.itemId, row.title]));
  const currentRun = activeRun
    ? {
        id: activeRun.id,
        itemTitle: itemTitles.get(activeRun.item_id) ?? "Your item",
        stageLabel: stagePresentation(activeRun.stage),
        reassurance: "You can leave. We’ll notify you when it’s ready.",
        progress: null,
      }
    : null;
  const attention = rows.notifications.flatMap<HomeProjection["attention"][number]>((notification) => {
    if (notification.kind === "buyer_message" && notification.source_message_id) {
      if (!actionableBuyerRoots.has(notification.source_message_id)) return [];
      return [
        {
          id: notification.id,
          itemTitle: notification.title,
          kind: "message" as const,
          status: "Buyer asked a question",
          detail: notification.body ?? "Open the buyer conversation to review the question.",
          actionLabel: "Reply",
          destination: {
            kind: "conversation" as const,
            id: notification.source_message_id,
          },
        },
      ];
    }
    const destinationID = notification.listing_id ?? notification.item_id;
    if (
      !destinationID ||
      (notification.kind !== "pipeline_failed" && notification.kind !== "listing_failed")
    ) {
      return [];
    }
    return [
      {
        id: notification.id,
        itemTitle: notification.title,
        kind: "warning" as const,
        status: "Needs review",
        detail: notification.body ?? "Open this listing to review what happened.",
        actionLabel: "Review",
        destination: {
          kind: notification.listing_id ? ("publishIssue" as const) : ("draft" as const),
          id: destinationID,
        },
      },
    ];
  });
  const readyToFinish = dashboardRows
    .filter((row) => ["draft", "draft_failed", "failed"].includes(row.status))
    .map((row) => ({ id: row.itemId, title: row.title, detail: listingPresentation(row.status).detail }));

  return homeProjectionSchema.parse({
    revision: timestampRevision(rows),
    sellerState:
      listings.length === 0 && rows.runs.length === 0 && rows.notifications.length === 0
        ? "newSeller"
        : "active",
    unreadNotificationCount: rows.unreadNotificationCount,
    summary: {
      active: rows.activeListingCount,
      drafts: rows.draftListingCount,
      // No tenant-owned order projection exists yet. Unknown is honest; zero is not.
      orders: null,
    },
    attention,
    currentRun,
    readyToFinish,
    listings,
    recentSearches: [],
  });
}

function assertTenantRows(userId: string, rows: Array<{ user_id?: string }>): void {
  if (rows.some((row) => row.user_id !== userId)) {
    throw new Error("Home projection crossed the verified tenant boundary.");
  }
}

export function createSupabaseHomeProjectionReader(
  clientForBearer: (bearerToken: string) => SupabaseClient | Promise<SupabaseClient>,
): HomeProjectionReader {
  return {
    async forSeller({ userId, bearerToken }) {
      const client = await clientForBearer(bearerToken);
      const [
        notificationResult,
        unreadNotificationResult,
        runResult,
        activeListingCountResult,
        draftListingCountResult,
        currentItemProjectionResult,
      ] =
        await Promise.all([
          client
            .from("notifications")
            .select("id,user_id,kind,title,body,item_id,listing_id,source_message_id,read_at,created_at")
            .order("created_at", { ascending: false })
            .limit(20),
          client
            .from("notifications")
            .select("id", { count: "exact", head: true })
            .is("read_at", null),
          client
            .from("pipeline_runs")
            .select(PIPELINE_PROGRESS_SELECT)
            .in("status", ["queued", "running", "retrying"])
            .order("updated_at", { ascending: false })
            .limit(8),
          client
            .from("listings")
            .select("id", { count: "exact", head: true })
            .eq("platform", "ebay")
            .eq("status", "published")
            .limit(1),
          client
            .from("listings")
            .select("id", { count: "exact", head: true })
            .eq("platform", "ebay")
            .in("status", ["draft", "queued"])
            .limit(1),
          client.rpc("get_home_current_item_projection"),
        ]);
      const failed = [
        notificationResult.error,
        unreadNotificationResult.error,
        runResult.error,
        activeListingCountResult.error,
        draftListingCountResult.error,
        currentItemProjectionResult.error,
      ].find(Boolean);
      if (failed) throw new Error("Home projection read failed.");
      if (unreadNotificationResult.count == null) {
        throw new Error("Home unread notification count was unavailable.");
      }
      if (activeListingCountResult.count == null || draftListingCountResult.count == null) {
        throw new Error("Home listing summary counts were unavailable.");
      }

      const notifications = (notificationResult.data ?? []) as HomeNotificationRow[];
      const runs = (runResult.data ?? []).map((row) => pipelineProgressRunSchema.parse(row));
      const currentItems = homeCurrentItemProjectionSchema.parse(
        currentItemProjectionResult.data,
      );
      const listings = currentItems.listings as HomeListingRow[];
      const items = currentItems.items as HomeItemRow[];
      const predictions = currentItems.predictions as HomePredictionRow[];
      const sourceMessageIDs = [
        ...new Set(
          notifications.flatMap((notification) =>
            notification.kind === "buyer_message" && notification.source_message_id
              ? [notification.source_message_id]
              : [],
          ),
        ),
      ];
      let messageRoots: HomeMessageRootRow[] = [];
      let canonicalDeliveredReplies: HomeMessageReplyRow[] = [];
      if (sourceMessageIDs.length > 0) {
        const messageRootResult = await client
          .from("messages")
          .select(
            "id,user_id,item_id,listing_id,direction,marketplace,body,status,created_at,updated_at",
          )
          .in("id", sourceMessageIDs)
          .eq("direction", "inbound")
          .limit(sourceMessageIDs.length);
        if (messageRootResult.error) throw new Error("Home conversation projection read failed.");
        messageRoots = (messageRootResult.data ?? []) as HomeMessageRootRow[];
        const rootIDs = [...new Set(messageRoots.map((root) => root.id))];
        if (rootIDs.length > 0) {
          const deliveredReplyResult = await client
            .from("messages")
            .select(
              "id,user_id,reply_to,direction,reply_kind,marketplace,delivery_status,external_delivery_id,sent_at,created_at,updated_at",
            )
            .in("reply_to", rootIDs)
            .eq("direction", "outbound")
            .eq("delivery_status", "delivered")
            .or("reply_kind.is.null,reply_kind.eq.reply")
            .order("sent_at", { ascending: false })
            .limit(rootIDs.length);
          if (deliveredReplyResult.error) {
            throw new Error("Home conversation projection read failed.");
          }
          canonicalDeliveredReplies = (deliveredReplyResult.data ??
            []) as HomeMessageReplyRow[];
        }
      }
      assertTenantRows(userId, [
        ...notifications,
        ...runs,
        ...listings,
        ...items,
        ...predictions,
        ...messageRoots,
        ...canonicalDeliveredReplies,
      ]);
      return assembleHomeProjection({
        notifications,
        unreadNotificationCount: unreadNotificationResult.count,
        activeListingCount: activeListingCountResult.count,
        draftListingCount: draftListingCountResult.count,
        runs,
        listings,
        items,
        predictions,
        messageRoots,
        messageReplies: canonicalDeliveredReplies,
        historyRevisionAt: currentItems.history_revision_at,
      });
    },
  };
}

export function createConfiguredSupabaseHomeProjectionReader(input: {
  supabaseURL: string;
  anonKey: string;
}): HomeProjectionReader {
  return createSupabaseHomeProjectionReader((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}
