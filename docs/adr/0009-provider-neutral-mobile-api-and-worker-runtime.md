# ADR-0009 — Provider-neutral mobile API and worker runtime

- **Status:** Accepted (2026-07-16)
- **Owned by:** issue #195 (architecture proof)
- **Production migration:** issue #196 (`Lane = Blocked`, `Phase 1`); no hosting change occurs in #195
- **Preserved owners:** #17, #159, #161, #162, #168, #173, and #174

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
- After re-evaluating all current candidates, choose **Railway** as the first migration target for
  the trusted mobile API plus bounded PGMQ consumer. It runs the proved Node/TypeScript Docker
  artifact with the least new infrastructure and no queue, domain, or durability-engine rewrite.
  This is an engineering-time decision, not a claim that Railway has the lowest raw compute price
  or the broadest platform maturity. Its $5 Hobby proof / recommended $20 Pro commercial commitment,
  four documented regions, manual horizontal scaling, pull-worker warm floor, deployment-time-only
  healthcheck, retention limits, spend-cap shutdown behavior, and Enterprise-only contractual SLA
  are explicit staging gates for #196.
- Rank **Render web service + background worker** second. Both run the existing Node/Docker code,
  and Render makes the API/continuous-worker split first-class with same-region private networking,
  health-gated web deploys, retained-artifact rollback, and documented `SIGTERM` shutdown. That is a
  clearer operational shape, not a new durability guarantee: the worker must stop claiming, respect
  the configurable 30–300 second shutdown window, and rely on PGMQ redelivery/lease fencing if a run
  cannot finish before `SIGKILL`. Separate 512 MiB Starter services create a $14/month paid-compute
  floor; the production-oriented $25 Pro workspace makes the planning floor $39 before overages,
  and its CPU/memory autoscaling is not queue-depth autoscaling. Render is not sufficiently easier or
  safer than Railway for this repo to justify that higher fixed floor and two-service coordination.
- Rank **Cloud Run service** third. Its request-based mode, minimum-instances
  zero, and 60-minute request timeout are a strong scale-to-zero fit for the API plus an authenticated
  scheduled bounded-consume endpoint. It trails the first two for the initial migration because it adds a
  GCP project, registry/deploy, IAM, logging, and scheduler surface. A continuous Cloud Run worker
  pool fits PGMQ pulling but has no native autoscaling and a billed warm floor; CREMA or Google
  Workflows scaling adds another control plane and custom PGMQ metric logic. Cloud Run jobs support
  168-hour tasks but still require execution orchestration and do not replace PGMQ lease/ack truth.
- Treat the current Vercel route as an interim adapter, not the SwiftUI contract. Fluid Compute is a
  viable API and bounded-worker fallback: current maxima are 300 seconds on Hobby, 800 seconds GA on
  Pro/Enterprise, and an optional 1,800-second beta for supported Node/Python functions. Vercel
  Workflows is GA and technically credible, but adding its queues, event log, step persistence,
  retries, and observability beside PGMQ/`pipeline_runs` would create two durability authorities.
  Evaluate it only as an intentional replacement in a separate ADR, never as an additive host seam.
- Rank **ECS on Fargate** as the strongest AWS container/PGMQ alternative, with materially more ECR,
  ECS, IAM, VPC/security-group, logging, and ALB or API Gateway configuration. **Lambda** retains a
  15-minute maximum and has no native PGMQ trigger, so it needs scheduled/external polling and is
  conditional on a representative p95 safely below that ceiling. **EC2** fits long-running work and
  can favor steady load, but makes SnapList own patching, hardening, scaling, failover, backups, and
  continuous operations. **App Runner** is rejected: AWS closed it to new customers on 2026-03-31,
  and eligible accounts still face a 120-second HTTP timeout and warm memory floor. **Amplify
  Hosting/Gen 2** is a frontend/full-stack serverless platform rather than a persistent worker host;
  its backend primitives would duplicate Clerk, Supabase, and PGMQ.
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
transport and composition; it does not implement eBay OAuth (#17), staging (#159),
retry/cancel/notifications (#161), scheduling/retention/health (#162), credits (#168), StoreKit
(#173), or App Attest (#174). Body-bearing 2xx responses use typed `data` + `meta.requestId`
envelopes; the eBay callback remains an explicit 303 redirect boundary.

### 4. Migration is a separate, review-gated change

The hosted migration is owned by issue #196 and may begin only after its declared
dependencies land. It must add a concrete Clerk JWT verifier, RLS-scoped Supabase request adapter,
provider configuration, staging acceptance, production-like measurements, and operator-controlled
cutover. Deployment, DNS, secrets, plans, Cron, production data, and live provider acceptance remain
outside #195.

## Consequences

- SwiftUI can generate a client from a stable HTTP contract while Next.js routes evolve or retire.
- Marketing delivery can remain optimized for Vercel without coupling trusted mobile compute to it.
- Railway offers the shortest first migration from the current Node/TypeScript dependency graph and
  keeps long-running bounded work out of edge-isolate limits. A continuous PGMQ poller cannot use
  Railway serverless sleep because its database traffic prevents outbound-idle detection, so the
  production plan must price a warm worker and use health/metrics beyond deployment checks.
- If Railway fails region/latency, production-bundle memory, availability, observability, or
  spend-control gates, Render is the lower-setup warm-worker alternative and Cloud Run service is the
  stronger scale-to-zero/mature-platform alternative. Both preserve the same composition root and
  PGMQ contracts; switching candidates does not authorize a second pipeline.
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
- [Vercel Workflows GA](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
- [Railway plans and usage pricing](https://docs.railway.com/pricing/plans)
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
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge resource limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase Edge pricing](https://supabase.com/docs/guides/functions/pricing)
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
