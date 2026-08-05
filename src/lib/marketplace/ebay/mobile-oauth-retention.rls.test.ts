import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import { createSupabaseMobileEbayOauthSessionStore } from "./mobile-oauth-store";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_RPC_SECRET = process.env.SERVER_RPC_SECRET;
const DATABASE_URL = resolveLocalTestDatabaseUrl();
const TEST_TIMEOUT_MS = 30_000;

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let lease: ExclusiveTestResourceLease | undefined;
let admin: SupabaseClient;
let tenantAId = "";
let tenantBId = "";
const seededIds: string[] = [];beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: "", requiredValues: [SECRET_KEY?.startsWith("sb_secret_"), SERVER_RPC_SECRET] });
  await whenStackReachable(reachable, async () => {
  lease = await acquireExclusiveTestResource(
    `local-db:mobile-ebay-oauth-retention:${SUPABASE_URL}`,
  );
  admin = createClient(SUPABASE_URL, SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  tenantAId = `user_test_mobile_oauth_retention_395_a_${suffix}`;
  tenantBId = `user_test_mobile_oauth_retention_395_b_${suffix}`;

  });}, TEST_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (reachable && seededIds.length > 0) {
      const database = new Client({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 2_000,
      });
      try {
        await database.connect();
        await database.query("begin");
        const expected = await database.query(
          `select id from public.ebay_oauth_sessions
           where user_id = any($1::text[])
             and id = any($2::uuid[])`,
          [[tenantAId, tenantBId], seededIds],
        );
        const deleted = await database.query<{ id: string }>(
          `delete from public.ebay_oauth_sessions
           where user_id = any($1::text[])
             and id = any($2::uuid[])
           returning id`,
          [[tenantAId, tenantBId], seededIds],
        );
        if (deleted.rowCount !== expected.rowCount) {
          throw new Error(
            `Expected to delete ${expected.rowCount ?? 0} recorded fixtures; deleted ${deleted.rowCount ?? 0}`,
          );
        }
        const residue = await database.query(
          `select id from public.ebay_oauth_sessions
           where user_id = any($1::text[]) or id = any($2::uuid[])`,
          [[tenantAId, tenantBId], seededIds],
        );
        if (residue.rowCount !== 0) {
          throw new Error("Mobile OAuth retention fixtures remained after cleanup");
        }
        await database.query("commit");
      } catch (error) {
        await database.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await database.end().catch(() => undefined);
      }
    }
  } finally {
    await lease?.release();
  }
}, TEST_TIMEOUT_MS);

describe("mobile eBay OAuth retention (DB-gated)", () => {
  it("purges only bounded owned sessions and hands every remaining owned row to account erasure", async () => {

    const ids = {
      active: randomUUID(),
      expired: randomUUID(),
      terminal: randomUUID(),
      recentTerminal: randomUUID(),
      foreignExpired: randomUUID(),
      foreignTerminal: randomUUID(),
    };
    seededIds.push(...Object.values(ids));
    const database = new Client({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await database.connect();
      await database.query(
        `insert into public.ebay_oauth_sessions (
           id, user_id, idempotency_key, status, expires_at, finished_at
         ) values
           ($1, $7, $1, 'pending', statement_timestamp() + interval '1 hour', null),
           ($2, $7, $2, 'pending', statement_timestamp() - interval '25 hours', null),
           ($3, $7, $3, 'declined', statement_timestamp() + interval '1 hour', statement_timestamp() - interval '25 hours'),
           ($4, $7, $4, 'cancelled', statement_timestamp() + interval '1 hour', statement_timestamp() - interval '1 hour'),
           ($5, $8, $5, 'pending', statement_timestamp() - interval '25 hours', null),
           ($6, $8, $6, 'failed', statement_timestamp() + interval '1 hour', statement_timestamp() - interval '25 hours')`,
        [
          ids.active,
          ids.expired,
          ids.terminal,
          ids.recentTerminal,
          ids.foreignExpired,
          ids.foreignTerminal,
          tenantAId,
          tenantBId,
        ],
      );

      const foreignBefore = await database.query<{ bytes: string }>(
        `select to_jsonb(session)::text as bytes
         from public.ebay_oauth_sessions session
         where session.user_id = $1
         order by session.id`,
        [tenantBId],
      );
      const first = await admin.rpc("cleanup_mobile_ebay_oauth_sessions", {
        p_user_id: tenantAId,
        p_limit: 1,
      });
      const second = await admin.rpc("cleanup_mobile_ebay_oauth_sessions", {
        p_user_id: tenantAId,
        p_limit: 1,
      });
      const replay = await admin.rpc("cleanup_mobile_ebay_oauth_sessions", {
        p_user_id: tenantAId,
        p_limit: 1,
      });

      expect(first).toMatchObject({
        data: { complete: false, deleted_count: 1, remaining_eligible_count: 1 },
        error: null,
      });
      expect(second).toMatchObject({
        data: { complete: true, deleted_count: 1, remaining_eligible_count: 0 },
        error: null,
      });
      expect(replay).toMatchObject({
        data: { complete: true, deleted_count: 0, remaining_eligible_count: 0 },
        error: null,
      });
      expect(JSON.stringify([first.data, second.data, replay.data])).not.toMatch(
        /token|code|secret|credential/i,
      );

      const active = await createSupabaseMobileEbayOauthSessionStore({
        supabaseURL: SUPABASE_URL,
        secretKey: SECRET_KEY!,
        serverRpcSecret: SERVER_RPC_SECRET!,
      }).getSession(ids.active);
      expect(active).toMatchObject({
        sessionId: ids.active,
        userId: tenantAId,
        status: "pending",
      });
      const ownedAfterRetention = await database.query<{ id: string }>(
        `select id from public.ebay_oauth_sessions
         where user_id = $1 order by id`,
        [tenantAId],
      );
      expect(ownedAfterRetention.rows.map(({ id }) => id).sort()).toEqual(
        [ids.active, ids.recentTerminal].sort(),
      );
      const foreignAfterRetention = await database.query<{ bytes: string }>(
        `select to_jsonb(session)::text as bytes
         from public.ebay_oauth_sessions session
         where session.user_id = $1 order by session.id`,
        [tenantBId],
      );
      expect(foreignAfterRetention.rows).toEqual(foreignBefore.rows);

      const erasure = await admin.rpc(
        "delete_mobile_ebay_oauth_sessions_for_account_erasure",
        { p_user_id: tenantAId },
      );
      expect(erasure).toMatchObject({
        data: { complete: true, deleted_count: 2, remaining_count: 0 },
        error: null,
      });
      const ownedAfterErasure = await database.query(
        `select id from public.ebay_oauth_sessions where user_id = $1`,
        [tenantAId],
      );
      expect(ownedAfterErasure.rows).toEqual([]);
      const foreignAfterErasure = await database.query<{ bytes: string }>(
        `select to_jsonb(session)::text as bytes
         from public.ebay_oauth_sessions session
         where session.user_id = $1 order by session.id`,
        [tenantBId],
      );
      expect(foreignAfterErasure.rows).toEqual(foreignBefore.rows);
    } finally {
      await database.end().catch(() => undefined);
    }
  });
});
