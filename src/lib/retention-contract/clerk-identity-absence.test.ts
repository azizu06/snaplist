import { createClerkClient } from "@clerk/nextjs/server";
import { afterAll, describe, expect, it } from "vitest";

// Completion proof for the `clerk-identity` row of
// docs/contracts/lean-mvp-retention-v1.json.
//
// The contract takes the verified-absence branch: SnapList does not claim a
// retention window it cannot observe, and it does not accept the `user.deleted`
// webhook as evidence — that webhook says the request was accepted, not that
// the record is gone. What SnapList proves is what this test proves: after
// `clerkClient.users.deleteUser(userId)`, reading the same user back through
// Clerk's own Backend API reports it absent.
//
// INTEGRATION: runs against a real Clerk DEVELOPMENT instance, and skips when
// one isn't configured — the same shape as the pgvector and RLS suites, which
// probe for the local Supabase stack rather than faking a pass. CI runs with no
// secrets by construction, so it skips there and runs locally via a `sk_test_`
// key in CLERK_SECRET_KEY.

const SECRET_KEY = process.env.CLERK_SECRET_KEY;

// A development key only. A `sk_live_` key would make this test create and
// delete users in the real identity instance, so it is refused outright rather
// than guarded by care.
const developmentInstance = SECRET_KEY?.startsWith("sk_test_") ?? false;

describe("Clerk identity deletion absence (integration; skips without a Clerk dev instance)", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (!developmentInstance || createdUserIds.length === 0) return;
    const clerk = createClerkClient({ secretKey: SECRET_KEY });
    // Only reached if an assertion failed before the delete under test.
    await Promise.allSettled(
      createdUserIds.map((id) => clerk.users.deleteUser(id)),
    );
  });

  it("requires a Clerk development instance (skips otherwise, never fakes a pass)", () => {
    if (!developmentInstance) {
      console.warn(
        "[clerk-identity-absence.test] No sk_test_ CLERK_SECRET_KEY — skipping " +
          "the Clerk deletion-absence proof. Set a development instance secret " +
          "key to run it.",
      );
    }
    expect(true).toBe(true);
  });

  it.runIf(developmentInstance)(
    "reports the user absent after deleteUser, which is the deletion proof",
    async () => {
      const clerk = createClerkClient({ secretKey: SECRET_KEY });

      const user = await clerk.users.createUser({
        emailAddress: [`retention-proof-${Date.now()}@snaplist.test`],
        password: `Retention-proof-${Date.now()}!`,
        skipPasswordChecks: true,
      });
      createdUserIds.push(user.id);

      // The record exists before deletion, so absence afterwards is caused by
      // the delete rather than by asking for an id that was never there.
      await expect(clerk.users.getUser(user.id)).resolves.toMatchObject({
        id: user.id,
      });

      await clerk.users.deleteUser(user.id);
      createdUserIds.length = 0;

      // Assert on the reported status, not merely that something threw: a
      // network or auth failure would also reject, and that is not absence.
      const readBack = await clerk.users
        .getUser(user.id)
        .then(() => null)
        .catch((error: unknown) => error);

      expect(readBack).toMatchObject({ status: 404 });
    },
    30_000,
  );
});
