# ADR-0009 — Provider-neutral mobile API and worker runtime

- **Status:** Accepted (2026-07-16)
- **Owned by:** issue #195 (architecture proof)
- **Production migration:** issue #196 (`Lane = Blocked`, `Phase 1`), deferred until an explicit
  upgrade trigger; no hosting or billing change occurs in #195
- **Preserved owners:** #17, #159, #161, #162, #168, #173, and #174

> **Lean-MVP scope amendment (2026-07-21):** ADR-0008/#349 is product authority for Scan and
> Trophy Wall. The retained v1 OpenAPI describes current runtime compatibility, not native
> navigation authority: `/v1/home` is a legacy projection. The one-to-five mobile submission
> maximum shipped through #352; optional voice context shipped through #351 and #774. This does not
> authorize the retired Home dashboard or let documentation claim more of the lean target is shipped
> than #352/#351/#774 actually cover.

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

### 1. Stage hosting by evidence and explicit owner authorization

Keep the public marketing site on Vercel, separate from trusted native compute; its plan eligibility
is a separate owner decision because Hobby permits only personal, non-commercial use. Aziz has
approved a strict **$0 infrastructure commitment during development and initial validation**: no
paid plan, billing account, payment method, or usage commitment is authorized by this ADR or issue
#195.

1. **Local development and automated verification now.** Run local Supabase and the implemented Node
   runtime/worker seams. Issue #195 proves `/v1/health`, `/v1/session`, the internal consume endpoint,
   queue/RPC validation, checkpointing, lease fencing, and completion-before-ack. It does **not**
   implement the #159-owned `/v1/items/runs` enqueue/RLS adapter, so the full local Node API + worker
   topology is the approved development target after that owner lands, not a current #195 result. The
   checked-in local/no-network container tests remain the automated proof of the implemented seams.
2. **Zero-cost remote prototype/TestFlight, with disclosed limits.** After the owning API/auth issues
   land, the smallest truthful no-billing topology is a free hosted Supabase project for
   Postgres/Storage/PGMQ, an optional Render Free web service for the versioned Node API, and the same
   Node worker running locally during supervised test sessions. The future API must enqueue and
   return; it never performs the durable pipeline inline. When the operator's worker is offline, runs
   remain queued and status stays pending until a supervised worker session resumes them.
   - Supabase Free currently allows two projects, 500 MB database per project, 1 GB Storage, 5 GB
     egress, and 500,000 Edge Function invocations. Low-activity projects may pause after seven days.
   - Render Free web services sleep after 15 minutes without inbound traffic, can take about a minute
     to wake, provide 750 instance-hours/month, may restart or suspend at platform limits, and cannot
     host a free background worker. With no payment method, exhaustion suspends service/builds rather
     than creating an overage charge.
   - Once those owner-owned operations exist, this path can exercise remote SwiftUI contract, auth,
     enqueue, status, RLS, and supervised durable completion. It cannot promise always-on processing,
     bounded queue latency, uptime, or unattended push/retry behavior. Those limitations must be
     visible to testers.
3. **Deferred paid production target.** Railway remains the first paid target because the proved
   Node/Docker API and persistent PGMQ worker require the least migration and no second durability
   engine. It is not required now. Railway Free provides only $1 monthly credit after its trial and
   cannot sustain a reliable always-on worker. Issue #196 may request provider/billing setup only when
   at least one owner-approved trigger occurs:
   - an external TestFlight cohort requires reliable unattended processing or bounded queue latency;
   - observed free-host cold starts, pauses, quotas, egress, or supervised-worker availability block
     a defined validation goal; or
   - the first real revenue/payment activation justifies a production infrastructure commitment.

The migration still must pass the representative provider-inclusive measurement, security, staging,
and operator cutover gates. Render web + paid background worker remains the second warm-worker option;
Cloud Run service remains the stronger scale-to-zero/mature-platform option, but Cloud Run requires
an active billing account even when usage fits its free allowance and therefore fails the current
no-billing/no-charge-risk constraint. Vercel Hobby is free but limited to personal, non-commercial
use and a 300-second function maximum; it is not the trusted external commercial TestFlight runtime.
Vercel Workflows remains a future intentional replacement candidate, never a second durability
engine beside PGMQ. Supabase Edge Functions remain Deno with a 150-second Free wall limit, 2-second
CPU limit, and 256 MB memory limit; avoiding payment does not justify rewriting the Node worker or
weakening ADR-0007.

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
- RevenueCat webhooks carry StoreKit lifecycle into the #173-owned authenticated, replay-protected
  verification seam. The server-owned Clerk/App User ID binding and #168 ledger remain authoritative;
  RevenueCat CustomerInfo and device claims never grant or reset entitlement. A future direct Apple
  signed-transaction verifier may feed the same narrow ledger seam without changing quota policy.

Most v1 operations are deliberately marked `contract-only` with `x-owner-issue`. Issue #195 proves
transport and composition; it does not implement eBay OAuth (#17), staging (#159),
retry/cancel/notifications (#161), scheduling/retention/health (#162), credits (#168), native billing
outside the #173 bridge, or App Attest (#174). Body-bearing 2xx responses use typed `data` + `meta.requestId`
envelopes; the eBay callback remains an explicit 303 redirect boundary.

### 4. Migration is a separate, review-gated change

The paid hosted migration is owned by issue #196 and remains deferred until both its declared
dependencies and one of the owner-approved upgrade triggers above are satisfied. It must add a
concrete Clerk JWT verifier, RLS-scoped Supabase request adapter, provider configuration, staging
acceptance, production-like measurements, and operator-controlled cutover. This ADR does not create
or authorize a Render, Railway, Cloud Run, Supabase, or Vercel resource. Deployment, billing accounts,
payment methods, DNS, secrets, plans, Cron, production data, and live provider acceptance remain
outside #195.

## Consequences

- SwiftUI can generate a client from a stable HTTP contract while Next.js routes evolve or retire.
- Marketing delivery can remain optimized for Vercel without coupling trusted mobile compute to it.
- Full-fidelity development stays local at $0. The optional remote pre-revenue topology is explicitly
  supervised: the hosted API can enqueue while the local worker is offline, and PGMQ preserves the
  run until the operator resumes the worker. It is not presented as production availability.
- Railway is a deferred production target, not an immediate requirement. A continuous PGMQ poller
  has a warm floor and cannot rely on Railway Free's $1 monthly credit; no paid setup begins without
  an explicit trigger and operator approval.
- Render and Cloud Run preserve the same composition root and PGMQ contracts if later selected.
  Switching candidates never authorizes a second pipeline or weakens completion-before-ack.
- The worker's security is still enforced at the narrow capability and Postgres RPC seams, not by
  trusting a host, queue payload, or caller-supplied tenant id.
- The air-gapped four-photo container profile measured a 6.402 ms wall p95, 10.041 ms process-CPU
  p95, and 171.1 MiB peak RSS across the actual durable orchestration/persistence-validation path.
  This grounds the 256 MiB minimum and baseline cost, while deterministic provider and RPC fixtures
  keep it explicitly a lower bound.
- Real model-stage p50/p95 duration, active CPU, peak RSS, and Supabase egress remain a pre-cutover
  measurement gate. The architecture proof keeps those planning sensitivities separate from its
  measured offline profile. All dollar figures in the comparison remain scenario assumptions until
  that representative provider-inclusive profile exists.

## Official references checked 2026-07-16

- [Vercel Fluid compute limits and duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel Hobby plans](https://vercel.com/docs/plans)
- [Vercel Hobby fair-use and commercial-use limits](https://vercel.com/docs/limits/fair-use-guidelines)
- [Vercel Workflows GA](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
- [Railway plans and usage pricing](https://docs.railway.com/pricing/plans)
- [Railway free trial and $1/month Free credit](https://docs.railway.com/pricing/free-trial)
- [Railway cost controls](https://docs.railway.com/pricing/cost-control)
- [Railway serverless sleeping](https://docs.railway.com/deployments/serverless)
- [Railway scaling](https://docs.railway.com/deployments/scaling)
- [Railway regions](https://docs.railway.com/deployments/regions)
- [Railway healthchecks](https://docs.railway.com/deployments/healthchecks)
- [Railway metrics](https://docs.railway.com/observability/metrics)
- [Railway logs](https://docs.railway.com/observability/logs)
- [Railway support and SLA](https://docs.railway.com/platform/support)
- [Render web services](https://render.com/docs/web-services)
- [Render background workers](https://render.com/docs/background-workers)
- [Render free-instance eligibility](https://render.com/docs/free)
- [Render Docker support](https://render.com/docs/docker)
- [Render private networking](https://render.com/docs/private-network)
- [Render deploys and graceful shutdown](https://render.com/docs/deploys)
- [Render rollbacks](https://render.com/docs/rollbacks)
- [Render scaling](https://render.com/docs/scaling)
- [Render workspace, compute, and bandwidth pricing](https://render.com/pricing)
- [Cloud Run service request timeout](https://cloud.google.com/run/docs/configuring/request-timeout)
- [Cloud Run billing settings](https://cloud.google.com/run/docs/configuring/billing-settings)
- [Cloud Run services, jobs, and worker pools](https://cloud.google.com/run/docs/overview/what-is-cloud-run)
- [Cloud Run job task timeout](https://cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run worker-pool CREMA autoscaling](https://cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling)
- [Cloud Run worker-pool Workflows scaling](https://cloud.google.com/run/docs/configuring/workerpools/workflows-autoscaling)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Google Cloud billing-account requirement](https://cloud.google.com/billing/docs/how-to/modify-project)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge resource limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase Edge pricing](https://supabase.com/docs/guides/functions/pricing)
- [Supabase Free quotas](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [AWS Lambda timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)
- [AWS Lambda event-source mappings](https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html)
- [AWS Lambda with EventBridge Scheduler](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [AWS App Runner request timeout](https://docs.aws.amazon.com/apprunner/latest/dg/develop.html)
- [AWS App Runner new-customer availability notice](https://docs.aws.amazon.com/apprunner/latest/api/API_ListServices.html)
- [AWS App Runner pricing](https://aws.amazon.com/apprunner/pricing/)
- [ECS/Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [ECS service load balancing](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html)
- [ECS IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html)
- [Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [EC2 security responsibilities](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security.html)
- [EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html)
- [EC2 pricing](https://aws.amazon.com/ec2/pricing/)
- [AWS Amplify overview](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html)
- [AWS Amplify Gen 2 backend deployment](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-backend.html)
