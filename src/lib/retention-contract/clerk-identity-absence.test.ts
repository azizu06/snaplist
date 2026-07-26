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
// Clerk's own Backend API reports it absent with status 404.
//
// INTEGRATION: runs against a real Clerk DEVELOPMENT instance, and skips the
// whole suite when one isn't configured — the same `describe.runIf` shape the
// database-gated suites use (see src/test/exclusive-resource-lock.test.ts).
// CI runs with no secrets by construction, so it skips there and runs locally
// via an `sk_test_` key in CLERK_RETENTION_PROOF_SECRET_KEY.

// A dedicated variable, not the app's ordinary CLERK_SECRET_KEY: this suite
// creates and deletes real users, so running it has to be a deliberate act
// rather than a side effect of having a dev key exported in your shell.
const SECRET_KEY = process.env.CLERK_RETENTION_PROOF_SECRET_KEY;

// A development key only. An `sk_live_` key would make this test create and
// delete users in the real identity instance, so it is refused outright rather
// than guarded by care.
const developmentInstance = SECRET_KEY?.startsWith("sk_test_") ?? false;

if (!developmentInstance) {
  console.warn(
    "[clerk-identity-absence.test] No sk_test_ CLERK_RETENTION_PROOF_SECRET_KEY — skipping the " +
      "Clerk deletion-absence proof. The clerk-identity disposition records this " +
      "proof as defined but not yet observed until this suite runs.",
  );
}

describe.runIf(developmentInstance)(
  "Clerk identity deletion absence",
  () => {
    const createdUserIds: string[] = [];

    afterAll(async () => {
      if (createdUserIds.length === 0) return;
      const clerk = createClerkClient({ secretKey: SECRET_KEY });
      // Only reached if an assertion failed before the delete under test.
      await Promise.allSettled(
        createdUserIds.map((id) => clerk.users.deleteUser(id)),
      );
    });

    it(
      "reports the user absent after deleteUser, which is the deletion proof",
      async () => {
        const clerk = createClerkClient({ secretKey: SECRET_KEY });

        // example.com, not a .test address: Clerk validates the address format
        // and rejects the RFC 6761 special-use .test TLD with
        // form_param_format_invalid. example.com is RFC 2606 documentation
        // space, so it passes validation and still cannot reach a real mailbox.
        const user = await clerk.users.createUser({
          emailAddress: [`retention-proof-${Date.now()}@example.com`],
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
  },
);
