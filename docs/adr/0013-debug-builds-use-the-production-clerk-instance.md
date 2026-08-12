# ADR-0013 — Debug builds authenticate against the production Clerk instance

- **Status:** Accepted
- **Date:** 2026-08-12
- **Owner:** issue #804

## Context

`ios/Configuration/SnapList.xcconfig` points every configuration at the production API origin
`https://snaplist.dev`. Until this decision, `SnapList.Debug.xcconfig` paired that origin with the
development Clerk instance `witty-walrus-27.clerk.accounts.dev`.

Production validates a session against the production Clerk instance `clerk.snaplist.dev`. A token
minted by the development instance carries a different issuer and is signed by a different JWKS, so
production rejected it. Every authenticated request from a Debug build was dead on arrival: sign-in
through the real UI succeeded, Settings rendered the account, and `POST /v1/items/runs` then returned
`401` — after the seller had already photographed and uploaded an item. The signed-in path was
therefore unexercisable on a simulator, pushing verification onto a physical device or onto direct
API calls that bypass the client.

Issue #804 offered three ways out:

1. Point Debug at a non-production API origin that trusts the development Clerk instance.
2. Give Debug the production Clerk publishable key.
3. Accept both issuers server-side.

## Decision

**Option 2.** Debug builds carry the production Clerk publishable key
(`pk_live_…`, frontend API domain `clerk.snaplist.dev`) and keep the production API origin.

A Clerk publishable key is not a secret. It is base64 of the instance's frontend API domain plus a
trailing `$`, behind a `pk_test_` or `pk_live_` prefix, and it ships inside every client binary and
every web page the instance serves. Committing it to `SnapList.Debug.xcconfig` publishes nothing that
the App Store build does not already publish, which is why it sits beside the equally public PostHog
and Sentry ingest keys rather than in a side channel. The Release configuration is unchanged: it
still takes both values from protected build settings with no committed fallback.

## Trust-boundary reasoning

What this does **not** do: it does not widen the production trust boundary. Production still trusts
exactly one issuer and one JWKS. Option 3 was rejected for precisely this reason — it would buy a
development convenience by permanently teaching production to accept tokens from an instance whose
user records, session lifetimes, and sign-up policy are development-grade.

What this **does** accept: a Debug build on a development machine now holds real seller sessions.
The consequences, weighed and accepted by the owner:

- A simulator or development device signed in against production holds a genuine production session
  token in that build's keychain, with that account's real data and real AI-item credits behind it.
  A run submitted from a Debug build is a real run and settles a real credit.
- Debug builds are not distributed. They exist on the owner's machines and in CI, so the exposure is
  the machine, not a population of users.
- Revocation is unchanged and instance-side: signing out, or revoking the session in the Clerk
  dashboard, ends it exactly as it would for an App Store build.
- Destructive exploration should use a throwaway production account rather than the owner's own.

Option 1 remains the cleaner long-term separation and is not foreclosed by this decision. It needs a
non-production deployment that trusts the development Clerk instance, which does not exist yet.
Should one appear, Debug can move to it by changing the origin and the key together — the pairing
check below enforces exactly that "together".

## Consequences

The pairing that produced #804 is now a build failure rather than a runtime `401`:

- `ios/Scripts/clerk-origin-pairing-lint.sh` runs as the first build phase of the `SnapList` target,
  on every configuration and every build. It fails the build when a `pk_test_` key is paired with a
  `snaplist.dev` origin, when a `pk_live_` key is paired with a loopback origin, or when the domain
  encoded inside the key disagrees with `SNAPLIST_CLERK_FRONTEND_DOMAIN` (the domain that also
  becomes the `webcredentials:` entitlement). An absent or unexpanded key stays the concern of
  `release-config-lint.sh`, so configuration-less builds are unaffected.
- `ios/Scripts/clerk-origin-pairing.test.sh` runs the lint against both crossed pairs, both
  consistent pairs, and the committed `SnapList.Debug.xcconfig` values themselves. It runs in the
  iOS workflow's `validate` job.
- `NativeAppConfiguration.resolve` throws `clerkInstanceOriginMismatch` for the same crossed pairs,
  and `MobileAPIContractTests` asserts the invariant against the values the build actually bundled,
  not against fixtures.
