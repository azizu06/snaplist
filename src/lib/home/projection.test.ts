import { describe, expect, it } from "vitest";
import {
  assembleHomeProjection,
  createSupabaseHomeProjectionReader,
} from "./projection";

describe("native Seller Home projection", () => {
  it("maps durable RLS rows into one truthful typed Home model", () => {
    const updatedAt = "2026-07-17T13:00:00.000Z";
    const itemID = "20800000-0000-4000-8000-000000000040";
    const listingID = "20800000-0000-4000-8000-000000000041";
    const projection = assembleHomeProjection({
      notifications: [
        {
          id: "20800000-0000-4000-8000-000000000042",
          user_id: "user_native",
          kind: "listing_failed",
          title: "Canon AE-1 needs review",
          body: "eBay needs one more category detail.",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: null,
          read_at: null,
          created_at: updatedAt,
        },
        {
          id: "20800000-0000-4000-8000-000000000044",
          user_id: "user_native",
          kind: "buyer_message",
          title: "Buyer asked about the Canon AE-1",
          body: "Does the light meter work?",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: "20800000-0000-4000-8000-000000000045",
          read_at: null,
          created_at: updatedAt,
        },
      ],
      unreadNotificationCount: 2,
      activeListingCount: 1,
      draftListingCount: 0,
      runs: [
        {
          id: "20800000-0000-4000-8000-000000000043",
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          status: "running",
          stage: "pricing",
          attempt_count: 1,
          max_attempts: 3,
          safe_failure_message: null,
          retention_cleaned_at: null,
          updated_at: updatedAt,
        },
      ],
      listings: [
        {
          id: listingID,
          user_id: "user_native",
          item_id: itemID,
          title: "Canon AE-1 film camera",
          status: "published",
          created_at: updatedAt,
          updated_at: updatedAt,
          listed_price: 210,
        },
      ],
      items: [
        {
          id: itemID,
          user_id: "user_native",
          attributes: { brand: "Canon", model: "AE-1" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      predictions: [
        {
          id: "20800000-0000-4000-8000-000000000046",
          user_id: "user_native",
          item_id: itemID,
          price: 205,
          created_at: updatedAt,
        },
      ],
    });

    expect(projection).toMatchObject({
      sellerState: "active",
      unreadNotificationCount: 2,
      summary: { active: 1, drafts: 0, orders: null },
      currentRun: {
        id: "20800000-0000-4000-8000-000000000043",
        itemTitle: "Canon AE-1",
        stageLabel: "Finding recent sold comps",
        progress: null,
      },
      attention: [
        {
          kind: "warning",
          destination: { kind: "publishIssue", id: listingID },
        },
        {
          kind: "message",
          status: "Buyer asked a question",
          actionLabel: "Reply",
          destination: {
            kind: "conversation",
            id: "20800000-0000-4000-8000-000000000045",
          },
        },
      ],
      listings: [
        {
          id: itemID,
          title: "Canon AE-1",
          lifecycle: "active",
          statusLabel: "Live",
          price: "$210",
        },
      ],
    });
  });

  it("filters active durable runs before applying the recent-run limit", async () => {
    const calls: string[] = [];
    const activeRun = {
      id: "20800000-0000-4000-8000-000000000043",
      user_id: "user_native",
      item_id: "20800000-0000-4000-8000-000000000040",
      listing_id: null,
      status: "running",
      stage: "pricing",
      attempt_count: 1,
      max_attempts: 3,
      safe_failure_message: null,
      retention_cleaned_at: null,
      updated_at: "2026-07-17T12:00:00.000Z",
    };
    const newerTerminalRuns = Array.from({ length: 8 }, (_, index) => ({
      ...activeRun,
      id: `20800000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`,
      status: "succeeded",
      stage: "completed",
      updated_at: `2026-07-17T13:0${index}:00.000Z`,
    }));
    let activeFilterApplied = false;

    const client = makeProjectionClient({
      pipelineRuns() {
        const query = makeQuery({ data: newerTerminalRuns, error: null });
        query.in = (column: string, values: unknown[]) => {
          calls.push(`in:${column}:${values.join(",")}`);
          activeFilterApplied = true;
          return query;
        };
        query.order = () => {
          calls.push("order");
          return query;
        };
        query.limit = async () => {
          calls.push("limit");
          return {
            data: activeFilterApplied ? [activeRun] : newerTerminalRuns,
            error: null,
          };
        };
        return query;
      },
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.currentRun?.id).toBe(activeRun.id);
    expect(calls).toEqual([
      "in:status:queued,running,retrying",
      "order",
      "limit",
    ]);
  });

  it("returns the exact unread count even when the presentation slice exceeds twenty", async () => {
    const notifications = Array.from({ length: 20 }, (_, index) => ({
      id: `20800000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      user_id: "user_native",
      kind: "pipeline_completed",
      title: `Ready ${index}`,
      body: null,
      item_id: null,
      listing_id: null,
      read_at: null,
      created_at: `2026-07-17T13:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const client = makeProjectionClient({ notifications, unreadCount: 27 });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.unreadNotificationCount).toBe(27);
  });

  it("uses exact global summary counts and paginates the complete searchable corpus", async () => {
    const timestamp = "2026-07-17T13:00:00.000Z";
    const queryCalls: string[] = [];
    const items = Array.from({ length: 103 }, (_, index) => ({
      id: `20800000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
      user_id: "user_native",
      attributes:
        index === 102
          ? { brand: "Globally searchable", model: "vintage lens" }
          : { brand: "Seller item", model: String(index + 1) },
      photos: [],
      price_override: null,
      cost_basis: null,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const listings = items.map((item, index) => ({
      id: `20800000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`,
      user_id: "user_native",
      item_id: item.id,
      title: `Listing ${index + 1}`,
      status: index < 101 ? "published" : "draft",
      created_at: timestamp,
      updated_at: timestamp,
      listed_price: index < 101 ? 25 : null,
    }));
    const client = makeProjectionClient({
      listings,
      items,
      activeCount: 101,
      draftCount: 2,
      queryCalls,
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.summary).toEqual({ active: 101, drafts: 2, orders: null });
    expect(projection.listings).toHaveLength(103);
    expect(
      projection.listings.some((listing) =>
        listing.title.toLowerCase().includes("globally searchable vintage lens"),
      ),
    ).toBe(true);
    expect(queryCalls).toEqual(
      expect.arrayContaining([
        "listings:count:published",
        "listings:count:draft,queued",
        "listings:range:0-99",
        "listings:range:100-199",
        "items:range:0-99",
        "items:range:100-199",
      ]),
    );
  });

  it("paginates prediction logs in a unique newest-first order", async () => {
    const queryCalls: string[] = [];
    const predictionPageIDs: string[] = [];
    const targetItemID = "20800000-0000-4000-8004-999999999999";
    const timestamp = "2026-07-17T13:00:00.000Z";
    const predictions = Array.from({ length: 99 }, (_, index) => ({
      id: `20800000-0000-4000-8003-${String(index + 1).padStart(12, "0")}`,
      user_id: "user_native",
      item_id: `20800000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`,
      price: index + 1,
      created_at: timestamp,
    })).concat([
      {
        id: "20800000-0000-4000-8003-999999999998",
        user_id: "user_native",
        item_id: targetItemID,
        price: 100,
        created_at: timestamp,
      },
      {
        id: "20800000-0000-4000-8003-999999999999",
        user_id: "user_native",
        item_id: targetItemID,
        price: 200,
        created_at: timestamp,
      },
    ]);
    const client = makeProjectionClient({
      predictions,
      predictionPageIDs,
      queryCalls,
      items: [
        {
          id: targetItemID,
          user_id: "user_native",
          attributes: { brand: "Boundary", model: "price" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      listings: [
        {
          id: "20800000-0000-4000-8005-999999999999",
          user_id: "user_native",
          item_id: targetItemID,
          title: "Boundary price",
          status: "published",
          created_at: timestamp,
          updated_at: timestamp,
          listed_price: null,
        },
      ],
      activeCount: 1,
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect.soft(
      queryCalls.filter((call) => call.startsWith("prediction_logs:")),
    ).toEqual([
      "prediction_logs:select:id,user_id,item_id,price,created_at",
      "prediction_logs:order:created_at:desc",
      "prediction_logs:order:id:desc",
      "prediction_logs:range:0-99",
      "prediction_logs:select:id,user_id,item_id,price,created_at",
      "prediction_logs:order:created_at:desc",
      "prediction_logs:order:id:desc",
      "prediction_logs:range:100-199",
    ]);
    expect.soft(predictionPageIDs).toHaveLength(predictions.length);
    expect.soft(new Set(predictionPageIDs).size).toBe(predictions.length);
    expect(projection.listings.find((listing) => listing.id === targetItemID)?.price).toBe(
      "$200",
    );
  });
});

type QueryResult = { data: unknown[] | null; error: null; count?: number | null };
type FakeQuery = {
  select: (columns?: string, options?: { count?: string; head?: boolean }) => FakeQuery;
  eq: (column: string, value: unknown) => FakeQuery;
  in: (column: string, values: unknown[]) => FakeQuery;
  order: (column: string, options?: unknown) => FakeQuery;
  limit: (count: number) => Promise<QueryResult>;
  range: (from: number, to: number) => Promise<QueryResult>;
  is: (column: string, value: unknown) => Promise<QueryResult>;
};

function makeQuery(result: QueryResult): FakeQuery {
  const query = {} as FakeQuery;
  query.select = () => query;
  query.eq = () => query;
  query.in = () => query;
  query.order = () => query;
  query.limit = async () => result;
  query.range = async (from, to) => ({
    ...result,
    data: result.data?.slice(from, to + 1) ?? null,
  });
  query.is = async () => result;
  return query;
}

function makeProjectionClient(input: {
  notifications?: unknown[];
  unreadCount?: number;
  pipelineRuns?: () => FakeQuery;
  listings?: unknown[];
  items?: unknown[];
  predictions?: unknown[];
  predictionPageIDs?: string[];
  activeCount?: number;
  draftCount?: number;
  queryCalls?: string[];
}) {
  return {
    from(table: string) {
      if (table === "pipeline_runs" && input.pipelineRuns) return input.pipelineRuns();
      if (table === "notifications") {
        let isExactCount = false;
        const query = makeQuery({ data: input.notifications ?? [], error: null });
        query.select = (_columns, options) => {
          isExactCount = options?.head === true && options.count === "exact";
          return query;
        };
        query.is = async () => ({
          data: null,
          error: null,
          count: isExactCount ? (input.unreadCount ?? 0) : null,
        });
        return query;
      }
      if (table === "listings") {
        let exactCount = false;
        let status: unknown = null;
        let statuses: unknown[] = [];
        const query = makeQuery({ data: input.listings ?? [], error: null });
        query.select = (_columns, options) => {
          exactCount = options?.head === true && options.count === "exact";
          return query;
        };
        query.eq = (column, value) => {
          if (column === "status") status = value;
          return query;
        };
        query.in = (column, values) => {
          if (column === "status") statuses = values;
          return query;
        };
        query.limit = async (count) => {
          if (exactCount) {
            input.queryCalls?.push(
              `listings:count:${
                status === "published" ? "published" : statuses.join(",")
              }`,
            );
            return {
              data: null,
              error: null,
              count:
                status === "published" || statuses.includes("published")
                  ? (input.activeCount ?? 0)
                  : (input.draftCount ?? 0),
            };
          }
          return { data: (input.listings ?? []).slice(0, count), error: null };
        };
        const range = query.range;
        query.range = async (from, to) => {
          input.queryCalls?.push(`listings:range:${from}-${to}`);
          return range(from, to);
        };
        return query;
      }
      if (table === "items") {
        const query = makeQuery({ data: input.items ?? [], error: null });
        query.limit = async (count) => ({
          data: (input.items ?? []).slice(0, count),
          error: null,
        });
        const range = query.range;
        query.range = async (from, to) => {
          input.queryCalls?.push(`items:range:${from}-${to}`);
          return range(from, to);
        };
        return query;
      }
      if (table === "prediction_logs") {
        type Prediction = {
          id: string;
          item_id: string;
          created_at: string;
        };
        const orders: Array<{ column: string; ascending: boolean }> = [];
        const query = makeQuery({ data: input.predictions ?? [], error: null });
        query.select = (columns) => {
          input.queryCalls?.push(`prediction_logs:select:${columns}`);
          return query;
        };
        query.order = (column, options) => {
          const ascending = (options as { ascending?: boolean } | undefined)?.ascending;
          orders.push({ column, ascending: ascending !== false });
          input.queryCalls?.push(
            `prediction_logs:order:${column}:${ascending === false ? "desc" : "asc"}`,
          );
          return query;
        };
        query.range = async (from, to) => {
          input.queryCalls?.push(`prediction_logs:range:${from}-${to}`);
          const compare = (left: Prediction, right: Prediction) => {
            for (const order of orders) {
              const leftValue = left[order.column as keyof Prediction];
              const rightValue = right[order.column as keyof Prediction];
              const comparison = leftValue.localeCompare(rightValue);
              if (comparison !== 0) return order.ascending ? comparison : -comparison;
            }
            return 0;
          };
          const ordered = [...(input.predictions ?? [])] as Prediction[];
          ordered.sort(compare);
          if (from > 0 && !orders.some((order) => order.column === "id")) {
            for (let start = 0; start < ordered.length; ) {
              let end = start + 1;
              while (end < ordered.length && compare(ordered[start], ordered[end]) === 0) {
                end += 1;
              }
              ordered.splice(start, end - start, ...ordered.slice(start, end).reverse());
              start = end;
            }
          }
          const page = ordered.slice(from, to + 1);
          input.predictionPageIDs?.push(...page.map((prediction) => prediction.id));
          return { data: page, error: null };
        };
        return query;
      }
      return makeQuery({ data: [], error: null });
    },
  };
}
