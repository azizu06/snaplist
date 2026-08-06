import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { issueEbayPhotoUrls } from "@/lib/marketplace/ebay/photo-access";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { GET } from "./route";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;
let admin: SupabaseClient;
let database: Client;
let owner: ClerkTestUser;
let foreign: ClerkTestUser;
const uploadedPaths = new Set<string>();
const originalEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

async function waitsOnAdvisoryLock(
  observer: Client,
  backendPID: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await observer.query<{ wait_event: string | null }>(
      "select wait_event from pg_stat_activity where pid = $1",
      [backendPID],
    );
    if (activity.rows[0]?.wait_event === "advisory") return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await stackReachable({
    url: SUPABASE_URL,
    apiKey: ANON_KEY,
    requiredValues: [ANON_KEY, SECRET_KEY],
  });
  await whenStackReachable(reachable, async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
    admin = createClient(SUPABASE_URL, SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    database = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    await database.connect();
    [owner, foreign] = await Promise.all([
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "ebay_photo_owner"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "ebay_photo_foreign"),
    ]);
  });
});

afterAll(async () => {
  if (reachable && admin) {
    if (uploadedPaths.size > 0) {
      await admin.storage.from("photos").remove([...uploadedPaths]);
    }
    // Deleting an item publishes durable Storage cleanup work that deliberately
    // outlives the item row, so this suite has to retire its own queue entries.
    // Left behind they inflate the queue-depth contracts other suites assert on.
    await database.query(
      `delete from private.pipeline_storage_cleanup_jobs
       where source_type = 'item_deletion' and photo_paths && $1::text[]`,
      [[...uploadedPaths]],
    ).catch(() => undefined);
    await cleanupClerkTestUsers(admin, [owner.id, foreign.id]);
    await database.end();
  }
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function storedPhoto(
  user: ClerkTestUser,
  label: string,
  bytes: Uint8Array,
): Promise<{ itemId: string; path: string }> {
  const path = `${user.id}/ebay-photo-access/${label}.png`;
  const upload = await user.client.storage
    .from("photos")
    .upload(path, bytes, { contentType: "image/png", upsert: true });
  if (upload.error) throw upload.error;
  uploadedPaths.add(path);
  const item = await user.client
    .from("items")
    .insert({ user_id: user.id, photos: [path], attributes: {} })
    .select("id")
    .single();
  if (item.error || !item.data) throw item.error ?? new Error("item insert failed");
  return { itemId: item.data.id as string, path };
}

describe("GET /m/[token] (real private Storage and token lookup)", () => {
  it("serves exactly the token-bound photo and ignores a caller-supplied foreign path", async () => {
    const ownerBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    const foreignBytes = Uint8Array.from([137, 80, 78, 71, 9, 8, 7]);
    const owned = await storedPhoto(owner, "owned", ownerBytes);
    const other = await storedPhoto(foreign, "foreign", foreignBytes);
    const [url] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const token = new URL(url!).pathname.split("/").at(-1)!;

    const foreignDirectRead = await owner.client.storage
      .from("photos")
      .download(other.path);
    expect(foreignDirectRead.data).toBeNull();
    expect(foreignDirectRead.error).not.toBeNull();
    const foreignTokenRows = await foreign.client
      .from("ebay_photo_access_tokens")
      .select("item_id")
      .eq("item_id", owned.itemId);
    expect(foreignTokenRows.error).toBeNull();
    expect(foreignTokenRows.data).toEqual([]);

    const response = await GET(
      new Request(
        `${url}?bucket=photos&path=${encodeURIComponent(other.path)}`,
      ),
      { params: Promise.resolve({ token }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ownerBytes);
    expect(ownerBytes).not.toEqual(foreignBytes);

    const mutatedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const mutated = await GET(
      new Request(`https://snaplist.dev/m/${mutatedToken}`),
      { params: Promise.resolve({ token: mutatedToken }) },
    );
    expect(mutated.status).toBe(404);
  });

  it("does not let one seller issue a token for another seller's item", async () => {
    const other = await storedPhoto(
      foreign,
      "foreign-issuance",
      Uint8Array.from([137, 80, 78, 71, 3, 3, 3]),
    );

    const issued = await owner.client.rpc("issue_ebay_photo_access_tokens", {
      p_item_id: other.itemId,
      p_ttl_seconds: 604800,
    });

    expect(issued.data).toBeNull();
    expect(issued.error?.message).toMatch(/item not found/i);
  });

  it("does not issue an owner's token for a guessed foreign Storage path", async () => {
    const other = await storedPhoto(
      foreign,
      "foreign-path",
      Uint8Array.from([137, 80, 78, 71, 2, 4, 6]),
    );
    const poisonedItem = await owner.client
      .from("items")
      .insert({ user_id: owner.id, photos: [other.path], attributes: {} })
      .select("id")
      .single();
    expect(poisonedItem.error).toBeNull();

    const urls = await issueEbayPhotoUrls(
      owner.client,
      poisonedItem.data!.id as string,
      { baseUrl: "https://snaplist.dev" },
    );

    expect(urls).toEqual([]);
  });

  it("issues a fresh 256-bit opaque token when the same photo is retried", async () => {
    const owned = await storedPhoto(
      owner,
      "randomness",
      Uint8Array.from([137, 80, 78, 71, 6, 6, 6]),
    );
    const [firstUrl] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const [secondUrl] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const firstToken = new URL(firstUrl!).pathname.split("/").at(-1)!;
    const secondToken = new URL(secondUrl!).pathname.split("/").at(-1)!;

    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).not.toBe(firstToken);
    expect(secondUrl).not.toContain(owner.id);
    expect(secondUrl).not.toContain(owned.itemId);
    expect(secondUrl).not.toContain(owned.path);
  });

  it("refuses an expired token with the same response as an unknown token", async () => {
    const owned = await storedPhoto(
      owner,
      "expired",
      Uint8Array.from([137, 80, 78, 71, 4, 5, 6]),
    );
    const [url] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const token = new URL(url!).pathname.split("/").at(-1)!;
    const digest = createHash("sha256").update(token).digest("hex");
    await database.query(
      `update public.ebay_photo_access_tokens
       set created_at = statement_timestamp() - interval '2 days',
           expires_at = statement_timestamp() - interval '1 day'
       where token_digest = decode($1, 'hex')`,
      [digest],
    );

    const expired = await GET(new Request(url!), {
      params: Promise.resolve({ token }),
    });
    const unknownToken = randomBytes(32).toString("base64url");
    const unknown = await GET(
      new Request(`https://snaplist.dev/m/${unknownToken}`),
      { params: Promise.resolve({ token: unknownToken }) },
    );

    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await expired.text()).toBe(await unknown.text());
    expect(expired.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });

  it("revokes the capability row when the seller removes its photo", async () => {
    const owned = await storedPhoto(
      owner,
      "removed",
      Uint8Array.from([137, 80, 78, 71, 7, 7, 7]),
    );
    const [url] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const token = new URL(url!).pathname.split("/").at(-1)!;
    const digest = createHash("sha256").update(token).digest("hex");

    const removal = await owner.client
      .from("items")
      .update({ photos: [] })
      .eq("id", owned.itemId);
    expect(removal.error).toBeNull();

    const rows = await owner.client
      .from("ebay_photo_access_tokens")
      .select("token_digest")
      .eq("token_digest", `\\x${digest}`);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([]);
    const response = await GET(new Request(url!), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(404);
  });

  it("revokes the capability row when the seller deletes its item", async () => {
    const owned = await storedPhoto(
      owner,
      "item-deleted",
      Uint8Array.from([137, 80, 78, 71, 5, 5, 5]),
    );
    const [url] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const token = new URL(url!).pathname.split("/").at(-1)!;

    const deletion = await owner.client.rpc("delete_item", { p_item_id: owned.itemId });
    expect(deletion.error).toBeNull();
    expect((deletion.data as { status: string }).status).toBe("deleted");

    const rows = await database.query<{ count: string }>(
      `select count(*)::text as count
       from public.ebay_photo_access_tokens
       where item_id = $1`,
      [owned.itemId],
    );
    expect(rows.rows[0]?.count).toBe("0");
    const response = await GET(new Request(url!), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(404);
  });

  it("revokes every seller photo capability when account erasure begins", async () => {
    const owned = await storedPhoto(
      owner,
      "erasure",
      Uint8Array.from([137, 80, 78, 71, 8, 8, 8]),
    );
    const [url] = await issueEbayPhotoUrls(owner.client, owned.itemId, {
      baseUrl: "https://snaplist.dev",
    });
    const token = new URL(url!).pathname.split("/").at(-1)!;
    const idempotencyKey = crypto.randomUUID();

    try {
      const begun = await admin.rpc("begin_account_erasure", {
        p_user_id: owner.id,
        p_idempotency_key: idempotencyKey,
      });
      expect(begun.error).toBeNull();

      const reissue = await owner.client.rpc("issue_ebay_photo_access_tokens", {
        p_item_id: owned.itemId,
        p_ttl_seconds: 604800,
      });
      expect(reissue.data).toBeNull();
      expect(reissue.error?.message).toMatch(/erasure/i);

      const rows = await database.query<{ count: string }>(
        `select count(*)::text as count
         from public.ebay_photo_access_tokens
         where user_id = $1`,
        [owner.id],
      );
      expect(rows.rows[0]?.count).toBe("0");
      const response = await GET(new Request(url!), {
        params: Promise.resolve({ token }),
      });
      expect(response.status).toBe(404);
    } finally {
      await database.query(
        "delete from private.account_erasure_generations where user_id = $1",
        [owner.id],
      );
    }
  });

  it("forces token issuance to retry when account erasure wins the tenant lock", async () => {
    const owned = await storedPhoto(
      owner,
      "erasure-race",
      Uint8Array.from([137, 80, 78, 71, 1, 3, 5]),
    );
    const writer = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    const eraser = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    const idempotencyKey = crypto.randomUUID();
    await Promise.all([writer.connect(), eraser.connect()]);

    try {
      const writerBackend = await writer.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      await writer.query("set role authenticated");
      await writer.query(
        "select set_config('request.jwt.claims', $1, false)",
        [JSON.stringify({ role: "authenticated", sub: owner.id })],
      );
      await eraser.query("set role service_role");
      await eraser.query(
        "select set_config('request.jwt.claims', $1, false)",
        [JSON.stringify({ role: "service_role" })],
      );
      await eraser.query("begin");
      await eraser.query(
        "select public.begin_account_erasure($1, $2::uuid)",
        [owner.id, idempotencyKey],
      );

      const lateIssuance = writer
        .query(
          "select * from public.issue_ebay_photo_access_tokens($1::uuid, 604800)",
          [owned.itemId],
        )
        .then(() => undefined, (error: unknown) => error);
      await expect(
        waitsOnAdvisoryLock(database, writerBackend.rows[0]!.pid),
      ).resolves.toBe(true);

      await eraser.query("commit");
      const lateError = await lateIssuance as { code?: string } | undefined;
      expect(lateError?.code).toBe("40001");
      expect(String(lateError)).toMatch(
        /retry after account erasure serialization/i,
      );
      const residue = await database.query<{ count: string }>(
        `select count(*)::text as count
         from public.ebay_photo_access_tokens
         where user_id = $1`,
        [owner.id],
      );
      expect(residue.rows[0]?.count).toBe("0");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await eraser.query("rollback").catch(() => undefined);
      await database.query(
        "delete from private.account_erasure_generations where user_id = $1",
        [owner.id],
      );
      await Promise.all([writer.end(), eraser.end()]);
    }
  });
});
