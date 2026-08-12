import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mintVerifiedGuestJwt } from "@/lib/supabase/test-users";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { createMobileApiHandler } from "./app";
import { createConfiguredSupabaseMobileRunOperations } from "./runs";

/**
 * Issue #791: a verified guest reads its own Trophy Wall through real RLS.
 *
 * The guest's bearer is an App Attest capability, so the route mints one
 * per-operation project JWT and the database — not the route — decides what the
 * guest may see. That makes the isolation claim here a claim about the live
 * policy, which is the only place it is worth proving.
 *
 * Production uses the publishable key at the gateway, so this suite does too:
 * a secret key in `apikey` could answer for a token that RLS would refuse.
 */
const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const CURSOR_SIGNING_SECRET = "offline-run-history-cursor-signing-secret";
const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

const OWNER_RUN = "79100000-0000-4000-8000-000000000001";
const OWNER_ITEM = "79100000-0000-4000-8000-000000000002";
const FOREIGN_RUN = "79100000-0000-4000-8000-000000000003";
const FOREIGN_ITEM = "79100000-0000-4000-8000-000000000004";
const OWNER_CAPABILITY_ID = "79100000-0000-4000-8000-000000000011";
const FOREIGN_CAPABILITY_ID = "79100000-0000-4000-8000-000000000012";
const OWNER_BEARER = "guestcap_owner_791";
const FOREIGN_BEARER = "guestcap_foreign_791";

function guestStackReachable(): Promise<boolean> {
  return stackReachable({
    apiKey: PUBLISHABLE_KEY,
    requiredValues: [PUBLISHABLE_KEY?.startsWith("sb_publishable_")],
    url: SUPABASE_URL,
  });
}

let reachable = false;
let ownerGuestId = "";
let foreignGuestId = "";
let ownerOperationJwt = "";
let foreignOperationJwt = "";

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await guestStackReachable();
  await whenStackReachable(reachable, async () => {
    ownerGuestId = `guest_791_owner_${Date.now()}`;
    foreignGuestId = `guest_791_foreign_${Date.now()}`;
    ownerOperationJwt = await mintVerifiedGuestJwt(
      ownerGuestId,
      OWNER_CAPABILITY_ID,
    );
    foreignOperationJwt = await mintVerifiedGuestJwt(
      foreignGuestId,
      FOREIGN_CAPABILITY_ID,
    );

    const database = new Client({ connectionString: DATABASE_URL });
    await database.connect();
    try {
      await database.query("begin");
      // Both guests get an identically well-formed run. The foreign one is
      // absent from the owner's page for exactly one reason — tenancy — and the
      // owner-visible assertion below would still pass if it were malformed.
      await database.query(
        `insert into public.items (id, user_id, attributes, photos)
         values
           ($1::uuid, $3, '{"brand":"Canon","model":"AE-1"}'::jsonb, array[$5::text]),
           ($2::uuid, $4, '{"brand":"Sony","model":"WH-1000XM4"}'::jsonb, array[$6::text])`,
        [
          OWNER_ITEM,
          FOREIGN_ITEM,
          ownerGuestId,
          foreignGuestId,
          `${ownerGuestId}/items/front.jpg`,
          `${foreignGuestId}/items/front.jpg`,
        ],
      );
      await database.query(
        `insert into public.pipeline_runs (
           id, user_id, item_id, idempotency_key, updated_at
         ) values
           ($1::uuid, $3, $5::uuid, 'guest-791-owner', '2026-08-12T17:16:58.000Z'),
           ($2::uuid, $4, $6::uuid, 'guest-791-foreign', '2026-08-12T17:16:59.000Z')`,
        [
          OWNER_RUN,
          FOREIGN_RUN,
          ownerGuestId,
          foreignGuestId,
          OWNER_ITEM,
          FOREIGN_ITEM,
        ],
      );
      await database.query("commit");
    } catch (error) {
      await database.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await database.end();
    }
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    const database = new Client({ connectionString: DATABASE_URL });
    await database.connect();
    try {
      await database.query(
        "delete from public.pipeline_runs where id = any($1::uuid[])",
        [[OWNER_RUN, FOREIGN_RUN]],
      );
      await database.query(
        "delete from public.items where id = any($1::uuid[])",
        [[OWNER_ITEM, FOREIGN_ITEM]],
      );
    } finally {
      await database.end();
    }
  });
});

function guestRunHistoryHandler() {
  const operations = createConfiguredSupabaseMobileRunOperations({
    supabaseURL: SUPABASE_URL,
    anonKey: PUBLISHABLE_KEY!,
    cursorSigningSecret: CURSOR_SIGNING_SECRET,
  });
  return createMobileApiHandler({
    async authenticate(token) {
      if (token === OWNER_BEARER) {
        return {
          kind: "verifiedGuest" as const,
          mintOperationToken: async () => ownerOperationJwt,
          userId: ownerGuestId,
        };
      }
      if (token === FOREIGN_BEARER) {
        return {
          kind: "verifiedGuest" as const,
          mintOperationToken: async () => foreignOperationJwt,
          userId: foreignGuestId,
        };
      }
      throw new Error("forged verified-guest capability");
    },
    runHistory: operations,
    runOperations: operations,
    worker: {
      consume: async () => ({
        claimed: 0,
        succeeded: 0,
        retrying: 0,
        failed: 0,
        skipped: 0,
      }),
    },
    requestId: () => "req_791_guest_run_history",
  });
}

async function runIdsFor(bearer: string): Promise<string[]> {
  const response = await guestRunHistoryHandler()(
    new Request("http://localhost/v1/runs?limit=50", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as {
    data: { entries: Array<{ run: { id: string } }> };
  };
  return body.data.entries.map((entry) => entry.run.id);
}

describe.runIf(await guestStackReachable())(
  "verified-guest Trophy Wall history under live RLS",
  () => {
    it("serves each guest exactly its own runs and never the other guest's", async () => {
      const ownerIds = await runIdsFor(OWNER_BEARER);
      const foreignIds = await runIdsFor(FOREIGN_BEARER);

      expect(ownerIds).toEqual([OWNER_RUN]);
      expect(ownerIds).not.toContain(FOREIGN_RUN);
      // The row the owner was refused is readable by the tenant that owns it,
      // so its absence above is scoping and not a broken fixture.
      expect(foreignIds).toEqual([FOREIGN_RUN]);
    });
  },
);
