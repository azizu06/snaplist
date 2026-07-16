# Mobile API/runtime hosting proof

> Scope: issue #195 architecture proof only. No deployment, DNS, plan, credential, hosted Cron,
> hosted-data mutation, or live provider acceptance is performed by these files or commands.

## Current entry-point inventory

The current routes remain valid web adapters. The v1 contract describes the future native transport;
it does not silently declare these routes migrated.

### Seller/native-relevant HTTP routes

| Current entry point | Current interface and implementation locality | Native contract disposition |
| --- | --- | --- |
| `POST /api/batch/item` | Cookie auth, quota, Storage, `createVisionPipeline`, `runPipelineAndPersist` | #159 owns durable `/v1/items/runs`; do not migrate here |
| `GET /api/batch/status` | Cookie auth and direct RLS-scoped item/listing read | #159 owns `/v1/runs/{runId}` |
| `POST /api/billing/checkout`, `POST /api/billing/portal` | Legacy Stripe web billing modules | Not native StoreKit entitlement |
| `GET /api/ebay/connect`, `GET /api/ebay/callback` | Next cookie/redirect state around shared eBay modules | #17 owns the server OAuth session/callback; provider tokens never transit SwiftUI |
| `GET/POST /api/ebay/publish` | RLS read plus shared `publishListingToEbayAndNotify` mutation seam | Later v1 adapter must reuse the shared mutation seam |
| `/api/inbox/*` | RLS-scoped sync, attachment, explicit send/follow-up/retry modules | Later v1 adapters; no autonomous send |
| `GET /api/search` | Cookie auth, RLS reads, signed photo URLs | Later native query contract |
| `GET /api/health` | Next-specific liveness | Proof adds provider-neutral `GET /v1/health` |

The web UI also invokes Next server actions for upload, review save/regeneration, archive/delete,
reprice, notification reads, publish, disconnect, and settings. Those actions are an inventory of
future native HTTP needs, not authorization for #195 to extract their domain behavior.

### Provider callbacks and webhooks

| Current/planned entry point | Contract |
| --- | --- |
| `POST /api/webhooks/stripe` | Raw-body Stripe signature then shared `handleStripeEvent`; legacy web billing |
| `GET/POST /api/ebay/account-deletion` | Challenge/verified notice then `eraseEbayUserData` |
| `GET /api/ebay/callback` | Browser OAuth callback; future v1 callback uses server-persisted state and opaque app completion |
| `POST /v1/webhooks/storekit` | Contract-only; #173 owns Apple-signed verification and entitlement mirror |
| `POST /v1/guest/attestations` | Contract-only; #174 owns App Attest verification and guest capability |

### Internal and scheduled entry points

| Current entry point | Deep module behind it | Ownership |
| --- | --- | --- |
| `POST /api/internal/pipeline-worker` | `createInternalPipelineWorker().consume()` | Existing adapter; #195 extracts shared composition only |
| `GET/POST /api/cron/inbox-sync` | `syncInboxForSeller` with scheduled repositories/adapters | Existing operations surface |
| `GET/POST /api/cron/reprice` | `runRepriceSweep` | Existing operations surface |
| `POST /internal/v1/pipeline/consume` | Same `createPipelineWorker().consume()` | Local proof; #162 owns hosted scheduling/health |

## Composition proof

```text
Next route --------------------┐
                              ├─> createPipelineWorker(capabilities)
Standalone Node HTTP adapter --┘       │
                                       ├─> createDurableVisionPipelineProcessor
                                       └─> consumePipelineQueue
                                             ├─> PipelineQueue (PGMQ adapter)
                                             ├─> run-derived worker RPC store
                                             └─> lease/checkpoint/complete/ack semantics
```

The standalone handler uses the Web `Request`/`Response` interface. `src/runtime/node/server.ts` is
only a Node HTTP adapter. The module accepts a bearer verifier and `PipelineWorker`; it does not know
Clerk cookies, Next route folders, generic Supabase clients, or provider implementations.

## Reproducible local and container smoke

Local:

```bash
pnpm install --frozen-lockfile
pnpm exec tsx scripts/mobile-runtime-smoke.ts
pnpm exec tsx scripts/mobile-runtime-pipeline-benchmark.ts
```

Container:

```bash
docker build -f Dockerfile.mobile-runtime-proof -t snaplist-mobile-runtime-proof .
docker run --rm --network none snaplist-mobile-runtime-proof
docker run --rm --network none snaplist-mobile-runtime-proof \
  ./node_modules/.bin/tsx scripts/mobile-runtime-pipeline-benchmark.ts
```

The smoke starts an ephemeral localhost Node server, checks `/v1/health`, crosses the injected bearer
authentication seam, and invokes one bounded worker pass. The worker uses the production
`createSupabasePgmqPipelineQueue` adapter, but its RPC capability is an in-memory recorder that
returns an empty claim. It can issue no network, database, model, Storage, billing, or marketplace
call. Expected PGMQ call:

```json
{
  "functionName": "claim_pipeline_messages",
  "args": { "p_quantity": 1, "p_visibility_timeout_seconds": 30 }
}
```

## Measurements and honest assumptions

Five isolated local process runs on 2026-07-16 (Node 22.19.0, macOS, TypeScript executed through
`tsx`) produced:

| Metric | Result |
| --- | --- |
| End-to-end median for server start + health + auth + empty PGMQ claim | **16.37 ms** |
| Range | 14.59–19.25 ms |
| Median RSS after the proof | **116,981,760 bytes (111.6 MiB)** |
| Median RSS increase during the proof | **3,325,952 bytes (3.17 MiB)** |
| Hosted/network/provider calls | **0** |

These are startup/transport measurements, not listing-pipeline latency.

The second command is a representative offline pipeline profile rather than an empty claim. It uses
four checked-in product photos (451,818 bytes total) and drives the actual private-photo byte path,
vision-stage composition, confidence assembly, durable consumer, PGMQ and worker-RPC validators,
three checkpoints, persistence-payload validation, completion, and acknowledgement. Extraction,
pricing, and listing providers are deterministic fixtures; RPCs are in-memory capability recorders.
The air-gapped Node 22 Alpine container produced this 25-run profile after three warmups:

| Metric | Measured result |
| --- | --- |
| Successful durable runs / checkpoints / acknowledgements | **25 / 75 / 25** |
| Wall time | **p50 2.000 ms · p95 6.402 ms · range 1.346–6.798 ms** |
| Process CPU | **p50 2.737 ms · p95 10.041 ms · range 1.343–13.450 ms** |
| Baseline / peak RSS | **131,977,216 / 179,367,936 bytes (125.9 / 171.1 MiB)** |
| Peak RSS increase | **47,390,720 bytes (45.2 MiB)** |
| Provider, database, Storage-network, and marketplace calls | **0** |

This is a measured application-overhead and memory lower bound for a complete durable run, not a
measurement of model/search latency or Supabase egress. `tsx` is a development loader rather than
the future production bundle. The measured 171.1 MiB peak makes **256 MiB the minimum candidate**;
the provider-inclusive planning sensitivity retains **512 MiB** until a production bundle and
sandbox provider stages are profiled.

Live provider acceptance was prohibited. Therefore no honest measured model-stage p50/p95 exists in
this issue. The current code supplies a **300-second design envelope**: both the Next route maximum
and default queue visibility/lease are 300 seconds, renewed at checkpoints. The cost model separates
the measured offline lower bound from a clearly labeled provider-inclusive sensitivity of 120
seconds wall time, 10 seconds active CPU, and 512 MiB per item. The 30/120/300-second sensitivity must
still be replaced by sandbox/provider p50/p95 before hosted cutover.

## Owner-approved zero-cost staging path

Aziz has authorized **$0 infrastructure spend only** during development and initial validation. No
payment method, billing account, paid plan, or provider setup is authorized by this proof.

| Stage | Truthful topology | What it proves | Explicit limitation / upgrade trigger |
| --- | --- | --- | --- |
| **Local development now / target** | Today: local Supabase plus the standalone Node health/session/internal-consume proof and durable worker. Target after #159: the local v1 enqueue/status API plus the same worker | Today proves runtime startup, queue/RPC validation, leases/checkpoints, redelivery, and completion-before-ack. It does not prove the #159-owned enqueue/RLS API; that operation remains contract-only | Keep current implemented flows on their existing adapters until owners land; do not describe #195 as a runnable full v1 backend |
| **$0 remote prototype/TestFlight (after API/auth owners land)** | Supabase Free hosts Postgres/Storage/PGMQ; an optional Render Free web service hosts only the Node API; the Node worker runs locally during supervised sessions | Will exercise remote SwiftUI auth/contract/enqueue/status plus queued durable completion when the operator worker is online | Not currently end-to-end in #195. Render sleeps after 15 inbound-idle minutes and may take about a minute to wake; no free Render background worker exists. When the local worker is offline, runs wait in PGMQ. No always-on latency, uptime, unattended retry, or push promise |
| **Deferred production** | Railway Node/Docker API plus persistent PGMQ worker, owned by #196 | Reliable unattended processing after all measurement/security/staging gates | Begins only when an external TestFlight cohort needs bounded unattended processing, a measured free-host limit blocks validation, or first revenue/payment activation justifies paid infrastructure |

Supabase Free currently provides two projects, 500 MB database per project, 1 GB Storage, 5 GB
egress, and 500,000 Edge Function invocations; low-activity projects may pause after seven days.
Render provides 750 Free web-service hours/month, but its free service may restart/suspend and cannot
host a background worker. Using Render without a payment method makes quota exhaustion suspend the
service or builds instead of producing an overage charge. This is the smallest remote topology that
preserves the Node worker without pretending it is continuous.

Railway Free's post-trial allowance is only $1 credit/month, so it is useful for a short deploy check,
not a reliable always-on worker. Cloud Run has a substantial free allowance but requires an active
Cloud Billing account even for free usage and therefore fails the strict no-billing/no-charge-risk
constraint. Vercel Hobby is $0 but is restricted to personal, non-commercial use and has a 300-second
function maximum; it remains a marketing/personal-preview plan-compliance question, not the trusted
external TestFlight worker. Public commercial marketing must resolve plan eligibility separately
before launch. Supabase Edge Free has 150 seconds wall time, 2 seconds CPU/request, 256 MB memory, and
a Deno runtime; it does not justify a second pipeline or premature rewrite.

## Measured baseline cost

At the measured container p95, a 256 MiB allocation consumes **0.0016005 GB-s and 0.010041 CPU-s per
item**. The issue's pilot/growth volumes therefore represent **0.16005 / 16.005 GB-s** and **1.0041 /
100.41 CPU-s** per month before provider time. Applying public prices and plan rules makes the dollar
figures below **measured-input scenario estimates**, not measured bills:

| Host | Pilot / growth measured-lower-bound estimate | Interpretation |
| --- | --- | --- |
| **Vercel Fluid** | **< $0.01 / < $0.01** variable compute | Plan and request/egress inclusions dominate this offline application overhead |
| **Railway** | **about $5 / $5** for a warm 256 MiB service after the Hobby minimum | Raw warm memory plus $0.05/GB egress remains below the $5 minimum in both volumes |
| **Render** | **$14 / $14** paid-compute floor, or **$39 / $39** with the production-oriented Pro workspace | Separate 512 MiB Starter web and background-worker services are $7 each; the worker has no free tier and Pro adds $25 before overages |
| **Cloudflare Workers** | **Not valid** | The measured 171.1 MiB Node/`tsx` peak exceeds the 128 MB isolate limit |
| **Supabase Edge** | **Not comparable** | The proof is Node, not Deno; provider-stage CPU remains unmeasured against the 2 s CPU limit |
| **AWS Lambda** | **$0 / $0** incremental compute | The measured GB-s and requests remain inside the published free tier |
| **AWS App Runner** | **about $2.56 / $2.56** before transfer/logs, if the account is eligible | The 0.5 GB provisioned-memory floor dominates; AWS closed App Runner to new customers on 2026-03-31 |

These figures are intentionally a lower bound: they price the measured application path and memory,
not absent model/search/Supabase-network time. They prevent the architecture proof from presenting an
assumption as a measurement while still grounding the minimum container size and fixed-cost floor.

## Provider-inclusive sensitivity and hosting comparison

The following planning sensitivity is **an assumption-only scenario, not measured provider-inclusive
pipeline cost**: **pilot** = 100 items, 2,000 API calls, 1 GB response egress/month; **growth** =
10,000 items, 200,000 API calls, 20 GB response egress/month; each item = 120 seconds wall, 10 seconds
active CPU, and 512 MiB. Prices are US-region public list prices checked 2026-07-16. Every dollar
figure below remains a scenario estimate until a production bundle and representative sandbox
provider stages supply p50/p95 wall time, active CPU, peak RSS, and bytes transferred. Figures
exclude AI/search providers, Supabase base plan/storage/database egress, logs, builds, tax, and
support.

### Runtime and operating-model comparison

| Host | Current runtime / scaling facts | Fit with ADR-0007 PGMQ | Scenario cost and operational consequence |
| --- | --- | --- | --- |
| **Vercel Fluid Compute** | Native Node. Hobby is $0, personal/non-commercial only, and max 300 s; Pro/Enterprise GA max 800 s, with an optional 1,800 s beta for supported Node/Python. Fluid pauses active-CPU billing during I/O but bills provisioned memory for the request lifetime. | An authenticated bounded-consume HTTP call can retain PGMQ, but execution remains request-duration-coupled and Vercel supplies no native PGMQ trigger. | Assumed raw IAD compute is about **$0.05 / $5.33**, generally inside plan inclusions. Hobby permitted use makes it unsuitable as SnapList's external commercial validation backend; longer paid durations do not supply worker wake-up. |
| **Vercel Workflows (GA)** | Durable, observable pause/resume workflows using Vercel Queues and persistence; GA since 2026-04-16. | Poor as an *additional* engine: it would duplicate PGMQ, `pipeline_runs`, redelivery, checkpoints, lease fencing, and ack authority. Credible only as an intentional replacement under a separate migration ADR. | Low operator burden, but underlying Fluid/persistence usage and the engineering cost of changing the durability model make it a high-migration option, not a hosting toggle. |
| **Railway** | Runs the proved Node/Docker artifact as an API and/or long-lived pull worker. Vertical resources autoscale within configured limits; horizontal replicas and multi-region placement are manual. A PGMQ pull loop emits outbound traffic, so the worker cannot sleep and has a warm floor. | Strongest paid direct fit: the existing process can claim PGMQ without a queue or domain rewrite. | Free supplies only $1 monthly credit after the trial and is not an always-on production plan. The deferred paid scenario is about **$5.05 / $6.19** on Hobby; Railway recommends $20 Pro for a commercial app. Region, cross-cloud egress, hard-limit shutdown, healthcheck/log retention, and SLA caveats remain #196 gates. |
| **Render web service + background worker** | Native Node and Docker. A web service receives HTTPS while a first-class worker continuously pulls. Deploys support health-gated cutover, rollback, and a 30–300 s `SIGTERM` shutdown window. Free web services sleep after 15 minutes without inbound traffic; background workers have no free tier. | Paid worker is a strong PGMQ fit. At $0, only the API can be hosted; the same Node worker must run locally during supervised sessions and queued work waits while it is offline. | No-payment-method Free is the chosen optional prototype API because quota exhaustion suspends rather than bills. Reliable paid topology is two 512 MiB Starter instances at **$14/month**, or **$39/month** with the production-oriented Pro workspace; scaling is CPU/memory-based, not PGMQ-depth-based. |
| **Cloud Run service** | HTTPS container with request timeout up to 60 min. Request-based billing allocates CPU around requests; instance-based billing covers the lifecycle; minimum instances zero scales to zero. Cloud Run usage requires an active Cloud Billing account. | Strong for the API and an authenticated scheduled bounded-consume endpoint; not a continuously polling worker without active requests or instance-based execution. | Excellent free allowance/low-volume economics and platform maturity, but the billing-account requirement violates the current strict no-billing constraint. Later use also adds GCP registry/deploy, IAM, logging, and scheduler/wake-up. |
| **Cloud Run job** | One-off task execution; 10 min default and up to 168 h per task; always instance-based billing. Execution must be manual, scheduled, API-triggered, or orchestrated. | Long-job capable but weakly aligned: each PGMQ batch needs a trigger and job-execution control plane, while PGMQ still owns retry/lease/ack truth. | Low raw task compute, no permanent worker required, but more orchestration and slower startup than a bounded service request. |
| **Cloud Run worker pool** | Designed for continuous pull workers, with CPU allocated and billing while instances run. No native autoscaling and at least one instance is required while enabled. | Excellent runtime shape for PGMQ pulling. Native backlog scaling does not exist; PGMQ is not a CREMA source. | Warm floor plus manual scaling. CREMA or Google Workflows scaling adds a separate autoscaler/control plane, APIs, secrets, IAM, and custom PGMQ metric logic. |
| **Cloudflare Workers** | 128 MB isolate; paid CPU limits can fit orchestration but the measured Node/`tsx` proof peaked at 171.1 MiB and needs compatibility/bundle work. | Weak: no native PGMQ trigger, and adopting Cloudflare Queues would replace rather than preserve ADR-0007. | Assumed paid floor/usage about **$5 / $6.40**; not a valid cost comparison until a production bundle fits the isolate. Attractive only as a later thin edge adapter. |
| **Supabase Edge Functions** | Deno runtime; 256 MB memory and 2 s CPU; wall clock is 150 s Free / 400 s paid. | Same provider, but the heavy Node dependency graph and CPU envelope do not map cleanly. PGMQ wake-up still needs an invocation path. | Free includes 500,000 invocations, but cost does not cure the runtime mismatch. Use Supabase Free for Postgres/Storage/PGMQ and keep the worker Node/local; do not rewrite the pipeline for a quota. |
| **AWS Lambda** | Native Node with a 900 s/15 min hard maximum and scale-to-zero economics. | Weak/conditional. PGMQ is not a Lambda event source, so EventBridge/Supabase must invoke a poller; SnapList still owns empty polling, redelivery, lease fencing, and ack. | Assumed 512 MiB × 120 s is **$0 / about $3.33** after the published free tier. Good only if representative p95 is safely below 15 min and scheduler latency/empty invocations are accepted. |
| **AWS App Runner** | Managed HTTP container, but requests time out at 120 s and at least one provisioned-memory instance remains. AWS closed the service to new customers on 2026-03-31. | Poor: API-only here, with no durable pull-worker primitive and a timeout equal to the assumed wall case. | Ineligible unless the account was already enrolled. Even then, assumed minimum 0.5 GB idle memory is about **$2.56/month** before active CPU, logs, and transfer. |
| **ECS on Fargate** | Portable long-running containers with no application request-duration ceiling; service autoscaling is available. | Strong. A warm service can pull PGMQ directly; scale-from-zero/backlog scaling needs a custom CloudWatch metric because PGMQ is not native. | Credible AWS alternative, but low-volume floors and setup span ECR, ECS, IAM, VPC/subnets/security groups, logs, and ALB or API Gateway/VPC Link. NAT, public IPv4, logs, and front door can outweigh raw task compute. |
| **EC2** | Full VM control and no platform duration limit; Auto Scaling, multi-AZ replacement, and load balancing are available only after configuration. | Excellent runtime fit for a steady API/pull worker. | Potentially strong committed steady-load economics, but poor low-volume economics and highest ongoing burden: guest OS patching, hardening, scaling, failover, backups, observability, and capacity operations. |
| **Amplify Hosting / Gen 2** | Frontend/full-stack serverless platform. Gen 2 backend primitives provision services such as Cognito/AppSync/DynamoDB/Lambda rather than a long-running worker host. | None without replatforming. Amplify Functions inherit Lambda's event/duration model. | Good frontend ergonomics are irrelevant to the trusted worker. Adopting its backend would duplicate Clerk, Supabase Postgres/RLS/Storage, and PGMQ, with high lock-in and migration cost. |

### Decision matrix

Ratings are comparative for SnapList (`low` cost/burden is favorable; `strong` fit is favorable), not
benchmarks. “Raw compute” excludes required front doors, warm capacity, network, logs, and operator
time; “low-volume” includes those obvious floors.

| Candidate | Raw compute | Low-volume cost | Long-job fit | PGMQ worker fit | Operational burden | Vendor lock-in | Migration effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vercel Fluid | Low | $0 only for personal/non-commercial Hobby | Medium (5m Hobby; 13m20s GA paid; 30m beta) | Medium via HTTP wake-up | Low | Medium | Low |
| Vercel Workflows | Low/medium | Low/medium | Strong | Weak unless replacing PGMQ | Low after migration | High | Very high |
| **Railway** | Medium | $1 Free credit is not always-on; paid deferred | Strong | **Strong** | **Low** | Low/medium | **Low** |
| **Render web + worker** | Medium | $0 sleeping API + supervised local worker; paid worker $14/$39 floor | Strong when paid | **Strong** when paid/local supervised | Low/medium | Low/medium | Low |
| Cloud Run service | Low | Low allowance but billing account required | Strong (60m request) | Strong via HTTP wake-up | Medium | Medium | Medium |
| Cloud Run job | Low | Low | **Strong** (168h task) | Medium/weak | Medium/high | Medium | Medium/high |
| Cloud Run worker pool | Low/medium | Medium (warm floor) | Strong | **Strong** | High without custom autoscaling | Medium | Medium/high |
| Cloudflare Workers | Low | Low | Weak for current memory/runtime | Weak | Medium | High | High |
| Supabase Edge | Low | Low | Weak for current CPU/runtime | Weak | Low/medium | High | High |
| AWS Lambda | Low | **Low** | Medium/weak (15m cap) | Weak | Medium | High | Medium/high |
| AWS App Runner | Medium | Medium (warm floor) | Weak (120s HTTP) | Weak | Low | Medium | Ineligible/new customers |
| ECS Fargate | Medium | Medium/high | Strong | **Strong** | High | Medium | High |
| EC2 | Low at committed steady load | High | Strong | **Strong** | **Very high** | Low/medium | Very high |
| Amplify Hosting / Gen 2 | Low for frontend | Low for frontend | None as worker | None | Medium if backend adopted | High | Very high |

### Owner-approved staged recommendation

1. **Now: local Supabase + implemented Node runtime/worker seams.** This is the ranked first choice
   because it is $0, creates no billing risk, and verifies the existing ADR-0007 consumer invariants.
   The full local v1 Node API/worker topology remains the target after #159 implements enqueue/status
   under RLS; #195 does not claim that owner-owned API exists.
2. **After API/auth owners land: Supabase Free + optional Render Free API + supervised local Node
   worker.** This is the smallest truthful $0 remote TestFlight topology, not a current runnable #195
   result. It must keep enqueue-and-return and durable PGMQ state, but it is intentionally not
   always-on: API cold starts can approach a minute, Supabase may pause for inactivity, and queued
   runs wait while the operator worker is offline. Test plans must schedule supervised worker windows
   and describe pending processing honestly.
3. **After an upgrade trigger: Railway paid API/worker under #196.** Railway remains the production
   preference because its Node/Docker/PGMQ locality minimizes engineering time. Payment is deferred
   until external testers need reliable unattended processing, an observed free-tier limit blocks a
   defined validation goal, or first revenue/payment activation justifies the commitment. The
   provider-inclusive measurement and security/staging gates still apply before any cutover.

Among paid fallbacks, Render remains second for a clear web-service/background-worker lifecycle and
Cloud Run service third for scale-to-zero and hyperscaler controls. Vercel Fluid remains an interim
framework adapter, while Vercel Workflows would be a separate durability replacement decision. The
AWS and edge options retain their matrix rankings. None is authorized for setup by #195.

All external compute still downloads photos/data from Supabase, so Supabase Storage/database egress
must be measured independently of the host's response-egress price.

## Pre-cutover evidence required from the migration owner

1. Production-built Node image peak RSS at idle and while processing 1–4 photos.
2. Repeat the checked-in offline profile with a production bundle, then run at least 30 sandbox
   provider stages reporting p50/p95 wall time, active CPU, peak RSS, bytes read from Supabase, and
   bytes returned.
3. Timeout/restart/redelivery acceptance at 30, 120, and 300 seconds with stale-lease rejection.
4. Concrete Clerk JWT verification plus RLS two-tenant tests; no caller-supplied `user_id`.
5. Staging-only eBay/StoreKit/App Attest callback fixtures from their owning issues.
6. Evidence that one declared upgrade trigger occurred, followed by explicit operator approval for
   provider, billing/plan, secrets, DNS, scheduler, and production traffic.
