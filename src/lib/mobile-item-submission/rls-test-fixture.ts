import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

export const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
export const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
export const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
export const DATABASE_URL = resolveLocalTestDatabaseUrl();

export const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
export const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
export const fiveJpegs = Array.from(
  { length: 5 },
  (_, ordinal) => new Uint8Array([...jpeg, ordinal]),
);

export function singlePhotoMultipart(costBasis = "12.50"): FormData {
  const body = new FormData();
  body.append(
    "photo",
    new File([jpeg.buffer], "front.jpg", { type: "image/jpeg" }),
  );
  body.append("costBasis", costBasis);
  return body;
}

export function multipart(costBasis = "12.50", reverse = false): FormData {
  const body = new FormData();
  const photos = reverse
    ? [[png, "back.png", "image/png"], [jpeg, "front.jpg", "image/jpeg"]]
    : [[jpeg, "front.jpg", "image/jpeg"], [png, "back.png", "image/png"]];
  for (const [bytes, name, type] of photos as Array<
    [Uint8Array, string, string]
  >) {
    body.append(
      "photo",
      new File([new Uint8Array(bytes).buffer], name, { type }),
    );
  }
  body.append("costBasis", costBasis);
  return body;
}

export function fivePhotoMultipart(
  costBasis = "12.50",
  order = [0, 1, 2, 3, 4],
  changedOrdinal: number | null = null,
): FormData {
  const body = new FormData();
  const photos = [
    [fiveJpegs[0], "front.jpg", "image/jpeg"],
    [fiveJpegs[1], "left.jpg", "image/jpeg"],
    [fiveJpegs[2], "back.jpg", "image/jpeg"],
    [fiveJpegs[3], "right.jpg", "image/jpeg"],
    [fiveJpegs[4], "detail.jpg", "image/jpeg"],
  ] as const;
  for (const ordinal of order) {
    const [originalBytes, name, type] = photos[ordinal]!;
    const bytes =
      changedOrdinal === ordinal
        ? new Uint8Array([...originalBytes, 0xff])
        : originalBytes;
    body.append("photo", new File([bytes.buffer], name, { type }));
  }
  body.append("costBasis", costBasis);
  return body;
}

export function request(
  token: string,
  key: string,
  body: FormData,
): Request {
  return new Request("http://127.0.0.1:3001/v1/items/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
    },
    body,
  });
}

export async function connectDatabase(
  applicationName: string,
): Promise<Client> {
  const client = new Client({
    application_name: applicationName,
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

export function createSubmissionAdminControl(): SupabaseClient {
  if (!SECRET_KEY?.startsWith("sb_secret_")) {
    throw new Error("A local Supabase secret key is required for test control.");
  }
  return createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface ClaimedStagingCleanup {
  jobId: string;
  leaseToken: string;
  photoPaths: string[];
}

export async function expireAndClaimStagingCleanup(input: {
  admin: SupabaseClient;
  cleanupId: string;
  database: Client;
}): Promise<ClaimedStagingCleanup> {
  await input.database.query(
    `update private.pipeline_staging_cleanup_intents intent
     set cleanup_after = intent.created_at
     where intent.cleanup_id = $1::uuid
       and intent.created_at <= statement_timestamp()`,
    [input.cleanupId],
  );
  const prepared = await input.admin.rpc("prepare_pipeline_retention", {
    p_batch_size: 100,
  });
  if (
    prepared.error ||
    (prepared.data as { storageJobsQueued?: number } | null)
      ?.storageJobsQueued !== 1
  ) {
    throw new Error("Expected one generation-fenced staging cleanup job.");
  }
  const claimed = await input.admin.rpc("claim_pipeline_storage_cleanup", {
    p_lease_seconds: 300,
  });
  const result = claimed.data as {
    kind?: string;
    job?: ClaimedStagingCleanup;
  } | null;
  if (claimed.error || result?.kind !== "claimed" || !result.job) {
    throw new Error("Expected one claimed staging cleanup job.");
  }
  return result.job;
}

export async function authorizeRemoveAndCompleteStagingCleanup(input: {
  admin: SupabaseClient;
  expectedPaths: string[];
  job: ClaimedStagingCleanup;
}): Promise<void> {
  const authorization = await input.admin.rpc(
    "authorize_pipeline_storage_cleanup",
    {
      p_job_id: input.job.jobId,
      p_lease_token: input.job.leaseToken,
    },
  );
  const authority = authorization.data as {
    kind?: string;
    photoPaths?: string[];
  } | null;
  if (
    authorization.error ||
    authority?.kind !== "authorized" ||
    JSON.stringify(authority.photoPaths) !== JSON.stringify(input.expectedPaths)
  ) {
    throw new Error("Expected exact generation-fenced Storage cleanup authority.");
  }
  const removal = await input.admin.storage.from("photos").remove(input.job.photoPaths);
  if (removal.error) throw removal.error;
  const completion = await input.admin.rpc("complete_pipeline_storage_cleanup", {
    p_job_id: input.job.jobId,
    p_lease_token: input.job.leaseToken,
  });
  if (completion.error || completion.data !== true) {
    throw new Error("Expected durable staging cleanup completion.");
  }
}

export async function proveVerifiedGuestRefreshWindow(input: {
  admin: SupabaseClient;
  database: Client;
}): Promise<{
  activeRows: number;
  atWindowIssued: boolean;
  earlyCode: string | undefined;
  repeatedEarlyCode: string | undefined;
}> {
  const userId = `guest_${crypto.randomUUID().replaceAll("-", "").padEnd(48, "0")}`;
  const firstCapabilityId = crypto.randomUUID();
  const atWindowCapabilityId = crypto.randomUUID();
  const repeatedCapabilityId = crypto.randomUUID();
  let digestByte = 0x71;
  const issue = (capabilityId: string) => {
    const activatedAt = new Date();
    return input.admin.rpc("issue_verified_guest_capability", {
      p_activated_at: activatedAt.toISOString(),
      p_bearer_digest: `\\x${Buffer.alloc(32, digestByte++).toString("hex")}`,
      p_capability_id: capabilityId,
      p_expires_at: new Date(activatedAt.getTime() + 30 * 60_000).toISOString(),
      p_user_id: userId,
    });
  };

  try {
    const first = await issue(firstCapabilityId);
    if (first.error || first.data !== true) {
      throw new Error("Expected initial verified guest capability issuance.");
    }
    const early = await issue(crypto.randomUUID());
    await input.database.query(
      `update private.verified_guest_capabilities
       set expires_at = statement_timestamp() + interval '5 minutes'
       where capability_id = $1::uuid`,
      [firstCapabilityId],
    );
    const atWindow = await issue(atWindowCapabilityId);
    const repeatedEarly = await issue(repeatedCapabilityId);
    const rows = await input.database.query<{ active_rows: number }>(
      `select count(*)::integer active_rows
       from private.verified_guest_capabilities
       where user_id = $1
         and state = 'active'
         and revoked_at is null
         and expires_at > statement_timestamp()`,
      [userId],
    );
    return {
      activeRows: rows.rows[0]!.active_rows,
      atWindowIssued: atWindow.error === null && atWindow.data === true,
      earlyCode: early.error?.code,
      repeatedEarlyCode: repeatedEarly.error?.code,
    };
  } finally {
    await input.database.query(
      `delete from private.verified_guest_capabilities where user_id = $1`,
      [userId],
    );
  }
}

export async function localSubmissionStackIsReachable(): Promise<boolean> {
  if (
    !PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
    !SECRET_KEY?.startsWith("sb_secret_") ||
    !new URL(SUPABASE_URL).hostname.match(/^(127\.0\.0\.1|localhost|::1)$/)
  ) {
    return false;
  }
  try {
    const health = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    return health.ok;
  } catch {
    return false;
  }
}
