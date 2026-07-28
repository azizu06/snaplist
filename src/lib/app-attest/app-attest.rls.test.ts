import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
const APP_ID = "TEAMID1234.dev.snaplist.ios";
const KEY_ID = Buffer.alloc(32, 0x33).toString("base64");
const RETENTION_KEY_IDS = [0x41, 0x42, 0x43, 0x44, 0x45].map((byte) =>
  Buffer.alloc(32, byte).toString("base64"),
);

let reachable = false;
let admin: Client;
let first: Client;
let second: Client;
const challengeIds: string[] = [];

async function connect(applicationName: string): Promise<Client> {
  const client = new Client({
    application_name: applicationName,
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1_000,
  });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function asServiceRole(client: Client): Promise<void> {
  await client.query("set role service_role");
}

async function issueChallenge(input: {
  challenge: Buffer;
  challengeId: string;
  environment?: "development" | "production";
  keyId: string | null;
  kind: "attestation" | "assertion";
}): Promise<void> {
  challengeIds.push(input.challengeId);
  await first.query(
    `select public.issue_app_attest_challenge(
       $1::uuid, $2::bytea, $3::text, $4::text, $5::text,
       statement_timestamp() + interval '5 minutes'
     )`,
    [
      input.challengeId,
      input.challenge,
      input.kind,
      input.keyId,
      input.environment ?? "production",
    ],
  );
}

async function claim(
  client: Client,
  input: {
    challengeId: string;
    environment?: "development" | "production";
    keyId: string | null;
    kind: "attestation" | "assertion";
  },
): Promise<Buffer | null> {
  const result = await client.query<{ challenge: Buffer | null }>(
    `select public.claim_app_attest_challenge(
       $1::uuid, $2::text, $3::text, $4::text
     ) as challenge`,
    [
      input.challengeId,
      input.kind,
      input.keyId,
      input.environment ?? "production",
    ],
  );
  return result.rows[0]!.challenge;
}

beforeAll(async () => {
  try {
    admin = await connect("app_attest_331_admin");
    first = await connect("app_attest_331_first");
    second = await connect("app_attest_331_second");
    await Promise.all([asServiceRole(first), asServiceRole(second)]);
    reachable = true;
  } catch {
    await Promise.allSettled([
      admin?.end(),
      first?.end(),
      second?.end(),
    ]);
  }
});

afterAll(async () => {
  if (!reachable) return;
  await admin.query(
    `delete from private.app_attest_challenges
     where challenge_id = any($1::uuid[])`,
    [challengeIds],
  );
  await admin.query(
    "delete from private.app_attest_keys where key_id = any($1::text[])",
    [[KEY_ID, ...RETENTION_KEY_IDS]],
  );
  await Promise.all([admin.end(), first.end(), second.end()]);
});

describe("App Attest private replay boundary", () => {
  it("atomically consumes an attestation challenge once under concurrency", async () => {
    if (!reachable) return;
    const challengeId = randomUUID();
    const challenge = Buffer.alloc(32, 0x31);
    await issueChallenge({
      challenge,
      challengeId,
      keyId: null,
      kind: "attestation",
    });

    const outcomes = await Promise.all([
      claim(first, { challengeId, keyId: null, kind: "attestation" }),
      claim(second, { challengeId, keyId: null, kind: "attestation" }),
    ]);
    expect(outcomes.filter((value) => value !== null)).toEqual([challenge]);
  });

  it("binds environment, rejects expiry, and preserves an unclaimed challenge", async () => {
    if (!reachable) return;
    const environmentChallengeId = randomUUID();
    await issueChallenge({
      challenge: Buffer.alloc(32, 0x32),
      challengeId: environmentChallengeId,
      keyId: null,
      kind: "attestation",
    });
    await expect(
      claim(first, {
        challengeId: environmentChallengeId,
        environment: "development",
        keyId: null,
        kind: "attestation",
      }),
    ).resolves.toBeNull();
    await expect(
      claim(first, {
        challengeId: environmentChallengeId,
        keyId: null,
        kind: "attestation",
      }),
    ).resolves.toEqual(Buffer.alloc(32, 0x32));

    const expiredChallengeId = randomUUID();
    challengeIds.push(expiredChallengeId);
    await admin.query(
      `insert into private.app_attest_challenges (
         challenge_id, challenge, kind, key_id, environment, created_at, expires_at
       ) values (
         $1, $2, 'attestation', null, 'production',
         statement_timestamp() - interval '2 minutes',
         statement_timestamp() - interval '1 minute'
       )`,
      [expiredChallengeId, Buffer.alloc(32, 0x34)],
    );
    await expect(
      claim(first, {
        challengeId: expiredChallengeId,
        keyId: null,
        kind: "attestation",
      }),
    ).resolves.toBeNull();
  });

  it("commits one strictly increasing assertion counter under concurrency", async () => {
    if (!reachable) return;
    const inserted = await first.query<{ committed: boolean }>(
      `select public.commit_app_attest_attestation(
         $1, $2, 'production', $3, $4::bytea, '1', 1
       ) as committed`,
      [
        KEY_ID,
        APP_ID,
        "-----BEGIN PUBLIC KEY-----\nfixed\n-----END PUBLIC KEY-----",
        Buffer.from("fixed-receipt"),
      ],
    );
    expect(inserted.rows[0]!.committed).toBe(true);

    const commit = (client: Client) =>
      client.query<{ committed: boolean }>(
        `select public.commit_app_attest_assertion(
           $1, $2, 'production', 1, '1', 1
         ) as committed`,
        [KEY_ID, APP_ID],
      );
    const outcomes = await Promise.all([commit(first), commit(second)]);
    expect(outcomes.map((result) => result.rows[0]!.committed).sort()).toEqual([
      false,
      true,
    ]);
  });

  it("does not expose the private RPCs to anonymous callers", async () => {
    if (!reachable) return;
    await first.query("reset role");
    await first.query("set role anon");
    await expect(
      first.query(
        `select public.read_app_attest_key($1::text)`,
        [KEY_ID],
      ),
    ).rejects.toThrow(/permission denied/i);
    await first.query("reset role");
    await asServiceRole(first);
  });

  it("deletes consumed and expired challenges while preserving active state", async () => {
    if (!reachable) return;
    const existingEligible = await admin.query<{ count: number }>(
      `select count(*)::integer as count
       from private.app_attest_challenges
       where consumed_at is not null
          or expires_at <= statement_timestamp()`,
    );
    const consumedId = randomUUID();
    const expiredId = randomUUID();
    const activeId = randomUUID();
    challengeIds.push(consumedId, expiredId, activeId);

    await admin.query(
      `insert into private.app_attest_challenges (
         challenge_id, challenge, kind, key_id, environment,
         created_at, expires_at, consumed_at
       ) values
         ($1, $4, 'attestation', null, 'production',
          statement_timestamp() - interval '5 minutes',
          statement_timestamp() + interval '5 minutes',
          statement_timestamp()),
         ($2, $4, 'attestation', null, 'production',
          statement_timestamp() - interval '10 minutes',
          statement_timestamp() - interval '1 second',
          null),
         ($3, $4, 'attestation', null, 'production',
          statement_timestamp(),
          statement_timestamp() + interval '5 minutes',
          null)`,
      [consumedId, expiredId, activeId, Buffer.alloc(32, 0x45)],
    );

    const firstCleanup = await admin.query<{
      result: { deletedChallenges: number; deletedKeys: number };
    }>(
      `select private.cleanup_app_attest_retention(
         statement_timestamp(), true, false
       ) as result`,
    );
    expect(firstCleanup.rows[0]!.result).toEqual({
      deletedChallenges: existingEligible.rows[0]!.count + 2,
      deletedKeys: 0,
    });

    const remaining = await admin.query<{ challenge_id: string }>(
      `select challenge_id
       from private.app_attest_challenges
       where challenge_id = any($1::uuid[])
       order by challenge_id`,
      [[consumedId, expiredId, activeId]],
    );
    expect(remaining.rows.map(({ challenge_id }) => challenge_id)).toEqual([
      activeId,
    ]);

    const repeat = await admin.query<{
      result: { deletedChallenges: number; deletedKeys: number };
    }>(
      `select private.cleanup_app_attest_retention(
         statement_timestamp(), true, false
       ) as result`,
    );
    expect(repeat.rows[0]!.result).toEqual({
      deletedChallenges: 0,
      deletedKeys: 0,
    });
  });

  it("deletes asserted and never-asserted keys only after 90 inactive days", async () => {
    if (!reachable) return;
    const [assertedStale, neverAssertedStale, active] = RETENTION_KEY_IDS;
    await admin.query(
      `insert into private.app_attest_keys (
         key_id, app_id, environment, public_key_pem, receipt,
         assertion_counter, bundle_version, validation_category,
         attested_at, last_asserted_at
       ) values
         ($1, $4, 'production', $5, $6, 7, '1', 1,
          statement_timestamp() - interval '100 days',
          statement_timestamp() - interval '91 days'),
         ($2, $4, 'production', $5, $6, 0, '1', 1,
          statement_timestamp() - interval '91 days', null),
         ($3, $4, 'production', $5, $6, 8, '1', 1,
          statement_timestamp() - interval '100 days',
          statement_timestamp() - interval '1 day')`,
      [
        assertedStale,
        neverAssertedStale,
        active,
        APP_ID,
        "-----BEGIN PUBLIC KEY-----\nretention\n-----END PUBLIC KEY-----",
        Buffer.from("current-receipt"),
      ],
    );

    const cleanup = await admin.query<{
      result: { deletedChallenges: number; deletedKeys: number };
    }>(
      `select private.cleanup_app_attest_retention(
         statement_timestamp(), false, true
       ) as result`,
    );
    expect(cleanup.rows[0]!.result).toEqual({
      deletedChallenges: 0,
      deletedKeys: 2,
    });

    const remaining = await admin.query<{ key_id: string }>(
      `select key_id
       from private.app_attest_keys
       where key_id = any($1::text[])`,
      [[assertedStale, neverAssertedStale, active]],
    );
    expect(remaining.rows.map(({ key_id }) => key_id)).toEqual([active]);
  });

  it("serializes concurrent cleanup and remains idempotent", async () => {
    if (!reachable) return;
    const concurrentKey = RETENTION_KEY_IDS[3]!;
    await admin.query(
      `insert into private.app_attest_keys (
         key_id, app_id, environment, public_key_pem, receipt,
         bundle_version, validation_category, attested_at
       ) values (
         $1, $2, 'production', $3, $4, '1', 1,
         statement_timestamp() - interval '91 days'
       )`,
      [
        concurrentKey,
        APP_ID,
        "-----BEGIN PUBLIC KEY-----\nconcurrent\n-----END PUBLIC KEY-----",
        Buffer.from("current-receipt"),
      ],
    );

    await Promise.all([first.query("reset role"), second.query("reset role")]);
    try {
      const outcomes = await Promise.all(
        [first, second].map((client) =>
          client.query<{
            result: { deletedChallenges: number; deletedKeys: number };
          }>(
            `select private.cleanup_app_attest_retention(
               statement_timestamp(), false, true
             ) as result`,
          ),
        ),
      );
      expect(
        outcomes.reduce(
          (total, outcome) => total + outcome.rows[0]!.result.deletedKeys,
          0,
        ),
      ).toBe(1);
    } finally {
      await Promise.all([asServiceRole(first), asServiceRole(second)]);
    }
  });

  it("immediately erases only explicitly supplied App Attest state", async () => {
    if (!reachable) return;
    const erasureKey = RETENTION_KEY_IDS[4]!;
    const linkedChallenge = randomUUID();
    const explicitChallenge = randomUUID();
    challengeIds.push(linkedChallenge, explicitChallenge);

    await admin.query(
      `insert into private.app_attest_keys (
         key_id, app_id, environment, public_key_pem, receipt,
         bundle_version, validation_category
       ) values ($1, $2, 'production', $3, $4, '1', 1)`,
      [
        erasureKey,
        APP_ID,
        "-----BEGIN PUBLIC KEY-----\nerasure\n-----END PUBLIC KEY-----",
        Buffer.from("current-receipt"),
      ],
    );
    await admin.query(
      `insert into private.app_attest_challenges (
         challenge_id, challenge, kind, key_id, environment, expires_at
       ) values
         ($1, $3, 'assertion', $4, 'production',
          statement_timestamp() + interval '5 minutes'),
         ($2, $3, 'attestation', null, 'production',
          statement_timestamp() + interval '5 minutes')`,
      [linkedChallenge, explicitChallenge, Buffer.alloc(32, 0x46), erasureKey],
    );

    const erased = await first.query<{
      result: { deletedChallenges: number; deletedKeys: number };
    }>(
      `select public.delete_app_attest_state_for_erasure(
         $1::uuid[], $2::text[]
       ) as result`,
      [[explicitChallenge], [erasureKey]],
    );
    expect(erased.rows[0]!.result).toEqual({
      deletedChallenges: 2,
      deletedKeys: 1,
    });

    const repeated = await first.query<{
      result: { deletedChallenges: number; deletedKeys: number };
    }>(
      `select public.delete_app_attest_state_for_erasure(
         $1::uuid[], $2::text[]
       ) as result`,
      [[explicitChallenge], [erasureKey]],
    );
    expect(repeated.rows[0]!.result).toEqual({
      deletedChallenges: 0,
      deletedKeys: 0,
    });
  });

  it("registers one exact hourly scheduler and reports its run-history health", async () => {
    if (!reachable) return;
    const jobs = await admin.query<{
      active: boolean;
      command: string;
      jobid: number;
      schedule: string;
    }>(
      `select jobid, schedule, command, active
       from cron.job
       where jobname = 'snaplist-app-attest-retention-hourly'`,
    );
    expect(jobs.rows).toEqual([
      expect.objectContaining({
        active: true,
        command:
          "select private.cleanup_app_attest_retention(statement_timestamp(), true, true);",
        schedule: "17 * * * *",
      }),
    ]);

    const privileges = await admin.query<{
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
    }>(
      `select
         has_function_privilege(
           'anon',
           'private.cleanup_app_attest_retention(timestamptz,boolean,boolean)',
           'EXECUTE'
         ) as anon,
         has_function_privilege(
           'authenticated',
           'private.cleanup_app_attest_retention(timestamptz,boolean,boolean)',
           'EXECUTE'
         ) as authenticated,
         has_function_privilege(
           'service_role',
           'private.cleanup_app_attest_retention(timestamptz,boolean,boolean)',
           'EXECUTE'
         ) as service_role`,
    );
    expect(privileges.rows[0]).toEqual({
      anon: false,
      authenticated: false,
      service_role: false,
    });

    const history = await admin.query<{ last_succeeded_at: Date | null }>(
      `select max(coalesce(history.end_time, history.start_time)) as last_succeeded_at
       from cron.job_run_details history
       where history.jobid = $1
         and history.status = 'succeeded'`,
      [jobs.rows[0]!.jobid],
    );
    const health = await admin.query<{
      last_succeeded_at: Date | null;
      retention_breach: boolean;
    }>(
      `select last_succeeded_at, retention_breach
       from private.app_attest_retention_scheduler_health`,
    );
    expect(health.rows).toHaveLength(1);
    expect(health.rows[0]!.last_succeeded_at).toEqual(
      history.rows[0]!.last_succeeded_at,
    );
    if (history.rows[0]!.last_succeeded_at === null) {
      expect(health.rows[0]!.retention_breach).toBe(true);
    }
  });
});
