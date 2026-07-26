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
    "delete from private.app_attest_keys where key_id = $1",
    [KEY_ID],
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
});
