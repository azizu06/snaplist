import { z } from "zod";
import type { AccountErasureIdentity } from "./service";

/**
 * The Clerk Backend surface this adapter needs, declared structurally so the
 * seam can be exercised without a live identity instance.
 */
export interface ClerkUserDeletionClient {
  users: {
    deleteUser(userId: string): Promise<unknown>;
    getUser(userId: string): Promise<unknown>;
  };
}

function reportedStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Deletes the Clerk user and proves absence the way the `clerk-identity` row of
 * docs/contracts/lean-mvp-retention-v1.json requires: read the same id back and
 * see a reported 404. Asserting on the status rather than on "the read threw"
 * is deliberate — a network or auth failure also rejects, and that is not
 * absence. A `user.deleted` webhook is an acknowledgement, never proof.
 */
export async function deleteClerkIdentity(
  client: ClerkUserDeletionClient,
  input: { clerkUserId: string },
): Promise<{ absent: boolean }> {
  const clerkUserId = z.string().min(1).parse(input.clerkUserId);

  try {
    await client.users.deleteUser(clerkUserId);
  } catch (error) {
    // Already gone is not a failure, but any other error leaves absence unproved.
    if (reportedStatus(error) !== 404) return { absent: false };
  }

  const readBack = await client.users
    .getUser(clerkUserId)
    .then(() => null)
    .catch((error: unknown) => error);

  return { absent: reportedStatus(readBack) === 404 };
}

export interface RevenueCatCustomerDeletionConfig {
  secretKey: string;
  /**
   * Required for the absence read-back. The v2 customer endpoints are the only
   * ones that can report a customer missing, and they are project-scoped.
   */
  projectId?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

const REVENUECAT_BASE_URL = "https://api.revenuecat.com";

/**
 * Deletes the RevenueCat customer and reports whether absence was actually
 * observed.
 *
 * Two provider details drive this shape:
 *
 *  1. `GET /v1/subscribers/{id}` **creates** the subscriber when it is missing
 *     (it answers 200 or 201). Using it as a read-back would recreate the record
 *     this function just deleted, so v1 is used for the delete only.
 *  2. `GET /v2/projects/{id}/customers/{id}` answers 404 both for a deleted
 *     customer and for a project whose account lacks access to those endpoints,
 *     which are still gated. A bare post-delete 404 is therefore not evidence.
 *
 * So absence is proved the same way the Clerk proof does it: the customer must
 * read back as present *before* the delete and missing *after* it. Anything
 * else — no project id, an unreachable read-back, an ambiguous status — returns
 * `absent: false`, which surfaces as `deletion_needs_attention`. SnapList would
 * rather ask a person than claim a deletion it did not witness.
 */
export async function deleteRevenueCatCustomer(
  config: RevenueCatCustomerDeletionConfig,
  input: { appUserId: string },
): Promise<{ absent: boolean }> {
  const appUserId = z.string().min(1).parse(input.appUserId);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const baseURL = config.baseURL ?? REVENUECAT_BASE_URL;
  const authorization = { authorization: `Bearer ${config.secretKey}` };

  const customerURL = config.projectId
    ? `${baseURL}/v2/projects/${encodeURIComponent(config.projectId)}`
      + `/customers/${encodeURIComponent(appUserId)}`
    : null;

  const presentBeforeDelete = customerURL === null
    ? false
    : (await fetchImpl(customerURL, { method: "GET", headers: authorization })).status === 200;

  const deletion = await fetchImpl(
    `${baseURL}/v1/subscribers/${encodeURIComponent(appUserId)}`,
    { method: "DELETE", headers: authorization },
  );
  if (!deletion.ok && deletion.status !== 404) return { absent: false };

  if (customerURL === null || !presentBeforeDelete) return { absent: false };

  const readBack = await fetchImpl(customerURL, { method: "GET", headers: authorization });
  return { absent: readBack.status === 404 };
}

export function createAccountErasureIdentity(dependencies: {
  clerk: ClerkUserDeletionClient;
  revenueCat: RevenueCatCustomerDeletionConfig;
}): AccountErasureIdentity {
  return {
    deleteClerkUser: (input) => deleteClerkIdentity(dependencies.clerk, input),
    deleteRevenueCatCustomer: (input) =>
      deleteRevenueCatCustomer(dependencies.revenueCat, input),
  };
}
