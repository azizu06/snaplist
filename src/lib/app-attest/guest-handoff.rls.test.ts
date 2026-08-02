import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import type { GuestClaimHandoffRecord } from "./guest-handoff";

const APP_ID = "TEAMID1234.dev.snaplist.ios";

interface Fixture {
  handoff: GuestClaimHandoffRecord;
}

let reachable = false;
let database: Client;
let authenticated: Client;
let first: Client;
let second: Client;
let lease: ExclusiveTestResourceLease | undefined;
const handoffIds: string[] = [];
const recoveryIds: string[] = [];
const itemIds: string[] = [];
const keyIds: string[] = [];

function guestUserId(keyId: string): string {
  return `guest_${createHash("sha256")
    .update(APP_ID)
    .update("\0")
    .update(keyId)
    .digest("hex")
    .slice(0, 48)}`;
}

async function seedFixture(marker: number): Promise<Fixture> {
  const keyId = Buffer.alloc(32, marker).toString("base64");
  const itemId = randomUUID();
  const recoveryId = randomUUID();
  const handoffId = randomUUID();
  const guest = guestUserId(keyId);
  const photoSetFingerprint = marker.toString(16).padStart(2, "0").repeat(32);
  const recoveryTokenHash = (marker + 1).toString(16).padStart(2, "0").repeat(32);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);

  keyIds.push(keyId);
  itemIds.push(itemId);
  recoveryIds.push(recoveryId);
  handoffIds.push(handoffId);

  await database.query(
    `insert into public.items (
       id, user_id, photos, attributes, review_revision,
       review_content_revision, photo_identity_kind,
       photo_identity_fingerprint
     ) values (
       $1, $2, array[$2 || '/guest-claims/front.enc'], '{}'::jsonb,
       $3, $3, 'content_sha256_set_v1', $4
     )`,
    [itemId, guest, randomUUID(), photoSetFingerprint],
  );
  await database.query(
    `insert into private.app_attest_keys (
       key_id, app_id, environment, public_key_pem, receipt,
       assertion_counter, bundle_version, validation_category
     ) values (
       $1, $2, 'production',
       '-----BEGIN PUBLIC KEY-----fixed', decode('01', 'hex'),
       1, '1', 1
     )`,
    [keyId, APP_ID],
  );
  await database.query(
    `insert into private.guest_draft_recoveries (
       id, guest_user_id, pipeline_run_id, item_id, draft_id,
       reservation_id, allowance_period_id, recovery_token_hash,
       encrypted_artifact, storage_manifest, storage_object_count,
       usable_draft_at, expires_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       '{}'::jsonb, '[]'::jsonb, 1,
       statement_timestamp(), statement_timestamp() + interval '24 hours'
     )`,
    [
      recoveryId,
      guest,
      randomUUID(),
      itemId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      recoveryTokenHash,
    ],
  );

  return {
    handoff: {
      appId: APP_ID,
      environment: "production",
      expiresAt,
      guestUserId: guest,
      handoffId,
      issuedAt,
      keyId,
      photoSetFingerprint,
      recoveryId,
      recoveryTokenHash,
      tokenDigest: Buffer.alloc(32, marker + 2),
    },
  };
}

async function asServiceRole(client: Client): Promise<void> {
  await client.query("set role service_role");
  await client.query(
    `select set_config(
       'request.jwt.claims', '{"role":"service_role"}', false
     )`,
  );
}

async function issue(
  client: Client,
  handoff: GuestClaimHandoffRecord,
): Promise<boolean> {
  const result = await client.query<{ issued: boolean }>(
    `select public.issue_guest_claim_handoff(
       $1::uuid, $2::bytea, $3::text, $4::text, $5::text,
       $6::text, $7::uuid, $8::text, $9::text,
       $10::timestamptz, $11::timestamptz
     ) as issued`,
    [
      handoff.handoffId,
      handoff.tokenDigest,
      handoff.keyId,
      handoff.appId,
      handoff.environment,
      handoff.guestUserId,
      handoff.recoveryId,
      handoff.recoveryTokenHash,
      handoff.photoSetFingerprint,
      handoff.issuedAt,
      handoff.expiresAt,
    ],
  );
  return result.rows[0]!.issued;
}

async function consume(client: Client, handoff: GuestClaimHandoffRecord) {
  return client.query<{
    guest_user_id: string;
    recovery_id: string;
    recovery_token_hash: string;
  }>(
    `select * from public.consume_guest_claim_handoff(
       $1::uuid, $2::bytea, $3::text, $4::text
     )`,
    [
      handoff.handoffId,
      handoff.tokenDigest,
      handoff.appId,
      handoff.environment,
    ],
  );
}

beforeAll(async () => {
  try {
    lease = await acquireExclusiveTestResource(
      "local-db:guest-claim-handoff",
    );
    database = new Client({
      application_name: "guest_claim_handoff_610_admin",
      connectionString: resolveLocalTestDatabaseUrl(),
      connectionTimeoutMillis: 2_000,
    });
    authenticated = new Client({
      application_name: "guest_claim_handoff_610_authenticated",
      connectionString: resolveLocalTestDatabaseUrl(),
      connectionTimeoutMillis: 2_000,
    });
    first = new Client({
      application_name: "guest_claim_handoff_610_first",
      connectionString: resolveLocalTestDatabaseUrl(),
      connectionTimeoutMillis: 2_000,
    });
    second = new Client({
      application_name: "guest_claim_handoff_610_second",
      connectionString: resolveLocalTestDatabaseUrl(),
      connectionTimeoutMillis: 2_000,
    });
    await Promise.all([
      database.connect(),
      authenticated.connect(),
      first.connect(),
      second.connect(),
    ]);
    const migrationPresent = await database.query<{ present: boolean }>(
      `select to_regprocedure(
         'public.consume_guest_claim_handoff(uuid,bytea,text,text)'
       ) is not null as present`,
    );
    reachable = migrationPresent.rows[0]?.present === true;
    if (reachable) await Promise.all([asServiceRole(first), asServiceRole(second)]);
  } catch {
    await Promise.allSettled([
      database?.end(),
      authenticated?.end(),
      first?.end(),
      second?.end(),
    ]);
    await lease?.release();
  }
});

afterAll(async () => {
  if (reachable) {
    await database.query(
      "delete from private.guest_claim_handoffs where handoff_id = any($1::uuid[])",
      [handoffIds],
    );
    await database.query(
      "delete from private.guest_draft_recoveries where id = any($1::uuid[])",
      [recoveryIds],
    );
    await database.query(
      "delete from private.app_attest_keys where key_id = any($1::text[])",
      [keyIds],
    );
    await database.query(
      "delete from public.items where id = any($1::uuid[])",
      [itemIds],
    );
  }
  await Promise.allSettled([
    database?.end(),
    authenticated?.end(),
    first?.end(),
    second?.end(),
  ]);
  await lease?.release();
});

describe("guest claim handoff live Postgres/RLS boundary", () => {
  it("denies generic table access and RPC execution to public tenant roles", async () => {
    if (!reachable) return;
    const privileges = await database.query<{
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
      service_select: boolean;
    }>(
      `select
         has_function_privilege(
           'anon',
           'public.consume_guest_claim_handoff(uuid,bytea,text,text)',
           'execute'
         ) as anon_execute,
         has_function_privilege(
           'authenticated',
           'public.consume_guest_claim_handoff(uuid,bytea,text,text)',
           'execute'
         ) as authenticated_execute,
         has_function_privilege(
           'service_role',
           'public.consume_guest_claim_handoff(uuid,bytea,text,text)',
           'execute'
         ) as service_execute,
         has_table_privilege(
           'service_role', 'private.guest_claim_handoffs', 'select'
         ) as service_select`,
    );
    expect(privileges.rows[0]).toEqual({
      anon_execute: false,
      authenticated_execute: false,
      service_execute: true,
      service_select: false,
    });

    await authenticated.query("set role authenticated");
    await expect(
      authenticated.query(
        "select * from public.consume_guest_claim_handoff($1, $2, $3, $4)",
        [randomUUID(), Buffer.alloc(32), APP_ID, "production"],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("round-trips the fixed bytea RPC and consumes exactly once under concurrency", async () => {
    if (!reachable) return;
    const fixture = await seedFixture(0x51);
    await expect(issue(first, fixture.handoff)).resolves.toBe(true);

    const outcomes = await Promise.all([
      consume(first, fixture.handoff),
      consume(second, fixture.handoff),
    ]);
    expect(outcomes.flatMap(({ rows }) => rows)).toEqual([{
      guest_user_id: fixture.handoff.guestUserId,
      recovery_id: fixture.handoff.recoveryId,
      recovery_token_hash: fixture.handoff.recoveryTokenHash,
    }]);
  });

  it("issues only for the exact key environment, recovery token, and photo set", async () => {
    if (!reachable) return;
    const fixture = await seedFixture(0x55);

    await expect(issue(first, {
      ...fixture.handoff,
      environment: "development",
    })).resolves.toBe(false);
    await expect(issue(first, {
      ...fixture.handoff,
      recoveryTokenHash: "ee".repeat(32),
    })).resolves.toBe(false);
    await expect(issue(first, {
      ...fixture.handoff,
      photoSetFingerprint: "dd".repeat(32),
    })).resolves.toBe(false);
    await expect(issue(first, fixture.handoff)).resolves.toBe(true);
  });

  it("rejects database-expired, unattested, and stale-photo handoffs", async () => {
    if (!reachable) return;
    const expired = await seedFixture(0x52);
    await database.query(
      `insert into private.guest_claim_handoffs (
         handoff_id, token_digest, key_id, app_id, environment,
         guest_user_id, recovery_id, recovery_token_hash,
         photo_identity_kind, photo_set_fingerprint, issued_at, expires_at
       ) values (
         $1, $2, $3, $4, 'production', $5, $6, $7,
         'content_sha256_set_v1', $8,
         statement_timestamp() - interval '2 minutes',
         statement_timestamp() - interval '1 minute'
       )`,
      [
        expired.handoff.handoffId,
        expired.handoff.tokenDigest,
        expired.handoff.keyId,
        APP_ID,
        expired.handoff.guestUserId,
        expired.handoff.recoveryId,
        expired.handoff.recoveryTokenHash,
        expired.handoff.photoSetFingerprint,
      ],
    );
    await expect(consume(first, expired.handoff)).resolves.toMatchObject({ rows: [] });
    const cleanup = await database.query<{ deleted: string }>(
      `select
         private.cleanup_guest_claim_handoff_retention()::text as deleted`,
    );
    expect(Number(cleanup.rows[0]!.deleted)).toBeGreaterThanOrEqual(1);

    const health = await database.query<{
      active: boolean;
      command: string;
      expired_rows: number;
      last_succeeded_at: Date | null;
      retention_breach: boolean;
      schedule: string;
    }>(
      `select
         active,
         command,
         expired_rows::integer,
         last_succeeded_at,
         retention_breach,
         schedule
       from private.guest_claim_handoff_retention_health`,
    );
    expect(health.rows).toHaveLength(1);
    expect(health.rows[0]).toMatchObject({
      active: true,
      command: "select private.cleanup_guest_claim_handoff_retention();",
      expired_rows: 0,
      schedule: "23 * * * *",
    });
    const lastSucceededAt = health.rows[0]!.last_succeeded_at;
    const staleOrMissingSuccess = lastSucceededAt === null
      || Date.now() - lastSucceededAt.getTime() > 60 * 60_000;
    expect(health.rows[0]!.retention_breach).toBe(staleOrMissingSuccess);

    const unattested = await seedFixture(0x53);
    await database.query(
      "delete from private.app_attest_keys where key_id = $1",
      [unattested.handoff.keyId],
    );
    await expect(issue(first, unattested.handoff)).resolves.toBe(false);

    const stalePhoto = await seedFixture(0x54);
    await expect(issue(first, stalePhoto.handoff)).resolves.toBe(true);
    await database.query(
      `update private.guest_claim_handoffs
       set photo_set_fingerprint = $1 where handoff_id = $2`,
      ["ff".repeat(32), stalePhoto.handoff.handoffId],
    );
    await expect(consume(first, stalePhoto.handoff)).resolves.toMatchObject({ rows: [] });
    await expect(
      database.query<{ count: number }>(
        `select count(*)::integer as count
         from private.guest_claim_handoffs where handoff_id = $1`,
        [stalePhoto.handoff.handoffId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
