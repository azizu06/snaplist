# ADR-0009 — Provider-neutral mobile API and worker runtime

- **Status:** Accepted (2026-07-16)
- **Owned by:** issue #195 (architecture proof)
- **Production migration:** issue #196 (`Lane = Blocked`, `Phase 1`); no hosting change occurs in #195
- **Preserved owners:** #159, #161, #162, #168, #173, and #174

## Context

SnapList is becoming a native SwiftUI product. The existing trusted HTTP surfaces are Next.js route
handlers and server actions on Vercel, while the durable worker is invoked through a Next.js route
with a 300-second maximum. SwiftUI must not learn Next.js path/layout/cookie details, and the
durable worker must not gain a second pipeline implementation merely to run on another host.

Supabase remains the owner of Postgres, Storage, Realtime, and the logged PGMQ Basic Queue. ADR-0007
already requires the worker to receive only a `PipelineQueue`, run-derived worker RPC capability,
and private-photo download capability. Lease fencing, checkpoint/resume, explicit acknowledgement,
RLS, and durable completion are database/domain contracts rather than hosting contracts.

The local proof and current hosting comparison are recorded in
[`mobile-runtime-hosting-proof.md`](../architecture/mobile-runtime-hosting-proof.md). The versioned
SwiftUI contract is [`mobile-api-v1.openapi.json`](../contracts/mobile-api-v1.openapi.json).

## Decision

### 1. Separate the marketing host from trusted native compute

- Keep the public marketing site on Vercel. This decision does not require the trusted native API
  or durable worker to share its host.
- Choose Railway as the primary low-operations target for the trusted mobile API plus bounded
  PGMQ consumer. It runs the existing Node/TypeScript modules and Docker artifact without a Deno,
  isolate, or domain rewrite and does not impose an HTTP request-duration ceiling on the worker.
- Treat the current Vercel route as an interim adapter, not the SwiftUI contract. Vercel remains a
  viable fallback for the API and short worker attempts, but the Hobby 300-second maximum equals the
  current visibility/lease envelope and leaves no failure/recovery margin.
- Keep AWS Lambda/App Runner as the scale/compliance escape hatch. It fits the duration and memory
  envelope but adds IAM, networking, deployment, log, and cost-surface complexity that is not
  justified for the current showcase.
- Do not choose Cloudflare Workers or Supabase Edge Functions for the durable pipeline worker.
  Cloudflare's 128 MB isolate and Node-compatibility migration, and Supabase Edge's Deno runtime plus
  CPU/memory limits, are poor fits for the current dependency graph and image/AI orchestration. A
  lightweight API gateway or webhook adapter may be reconsidered separately after the Node runtime
  is measured in production-like tests.

### 2. One deep pipeline module, multiple thin runtime adapters

`createPipelineWorker` is the provider-neutral composition root. It receives only the existing
`PipelineWorkerCapabilities`, constructs the existing durable vision processor, and calls the
existing `consumePipelineQueue`. The Next.js internal route and the standalone Node process are
adapters at the same seam.

The deletion test is positive: removing this module would duplicate capability wiring, photo-bucket
restriction, processor construction, and consumer configuration in every host. Keeping it produces
leverage for runtime adapters and locality for ADR-0007 security invariants.

The proof does not change:

- the strict `{ run_id, schema_version }` queue envelope;
- PGMQ queue behavior or `PipelineQueue`;
- run/message pairing, lease tokens, or checkpoint fencing;
- run-derived worker RPC authority or RLS;
- durable completion-before-ack semantics;
- pricing, generation, billing, entitlement, publish, messaging, or notification behavior.

### 3. SwiftUI depends on HTTP v1, not framework implementation

The OpenAPI 3.1 contract fixes these transport invariants:

- versioned `/v1/...` paths and stable success/error envelopes with request ids;
- `Authorization: Bearer <Clerk JWT>` for signed-in calls; the server verifies issuer, audience,
  signature, expiry, and `sub`, then uses that same opaque token only with an RLS-scoped Supabase
  client. A request body can never supply or override `user_id`;
- a separate short-lived guest capability only after #174-owned App Attest verification;
- `Idempotency-Key` on logical mutations. Replays return the original logical result and cannot
  create another run, credit reservation, or marketplace action;
- a separate internal worker identity unavailable to SwiftUI;
- eBay OAuth state/code exchange and provider tokens remain server-side; SwiftUI receives only an
  opaque completion/deep-link result;
- StoreKit server notifications carry Apple-signed payloads to the #173-owned verification seam;
  device claims never grant or reset entitlement.

Most v1 operations are deliberately marked `contract-only` with `x-owner-issue`. Issue #195 proves
transport and composition; it does not implement staging (#159), retry/cancel/notifications (#161),
scheduling/retention/health (#162), credits (#168), StoreKit (#173), or App Attest (#174).

### 4. Migration is a separate, review-gated change

The hosted migration is owned by issue #196 and may begin only after its declared
dependencies land. It must add a concrete Clerk JWT verifier, RLS-scoped Supabase request adapter,
provider configuration, staging acceptance, production-like measurements, and operator-controlled
cutover. Deployment, DNS, secrets, plans, Cron, production data, and live provider acceptance remain
outside #195.

## Consequences

- SwiftUI can generate a client from a stable HTTP contract while Next.js routes evolve or retire.
- Marketing delivery can remain optimized for Vercel without coupling trusted mobile compute to it.
- Railway offers the shortest migration from the current Node/TypeScript dependency graph and keeps
  long-running bounded work out of edge-isolate limits.
- A warm container has a small monthly floor; Railway serverless sleep may introduce a cold boot and
  may not activate while Supabase connections or telemetry produce outbound traffic.
- The worker's security is still enforced at the narrow capability and Postgres RPC seams, not by
  trusting a host, queue payload, or caller-supplied tenant id.
- Real model-stage p50/p95 duration, active CPU, peak RSS, and Supabase egress remain a pre-cutover
  measurement gate. The architecture proof does not substitute mock timing for those values.

## Official references checked 2026-07-16

- [Vercel Fluid compute limits](https://vercel.com/docs/fluid-compute)
- [Vercel Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Railway pricing](https://docs.railway.com/pricing)
- [Railway serverless sleeping](https://docs.railway.com/deployments/serverless)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge resource limits](https://supabase.com/docs/guides/troubleshooting/edge-function-546-error-response)
- [Supabase Edge pricing](https://supabase.com/docs/guides/functions/pricing)
- [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [AWS App Runner pricing](https://aws.amazon.com/apprunner/pricing/)
