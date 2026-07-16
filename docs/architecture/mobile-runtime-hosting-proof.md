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
| **Vercel Fluid Compute** | Native Node. Hobby max 300 s; Pro/Enterprise GA max 800 s. Supported Node/Python functions may opt per function into a 1,800 s beta limit. Fluid pauses active-CPU billing during I/O but bills provisioned memory for the request lifetime. | An authenticated bounded-consume HTTP call can retain PGMQ, but execution remains request-duration-coupled and Vercel supplies no native PGMQ trigger. | Assumed raw IAD compute is about **$0.05 / $5.33**, generally inside plan inclusions. Excellent API locality and low ops; duration is no longer the categorical blocker the old 300 s comparison implied. |
| **Vercel Workflows (GA)** | Durable, observable pause/resume workflows using Vercel Queues and persistence; GA since 2026-04-16. | Poor as an *additional* engine: it would duplicate PGMQ, `pipeline_runs`, redelivery, checkpoints, lease fencing, and ack authority. Credible only as an intentional replacement under a separate migration ADR. | Low operator burden, but underlying Fluid/persistence usage and the engineering cost of changing the durability model make it a high-migration option, not a hosting toggle. |
| **Railway** | Runs the proved Node/Docker artifact as an API and/or long-lived pull worker. Vertical resources autoscale within configured limits; horizontal replicas and multi-region placement are manual. A PGMQ pull loop emits outbound traffic, so the worker cannot sleep and has a warm floor. | Strongest direct fit: the existing process can claim PGMQ without a queue or domain rewrite; scheduled bounded HTTP consumption also remains possible. | Assumed one warm 0.5 GB service is about **$5.05 / $6.19** on the $5 Hobby proof plan. Railway recommends the $20 Pro plan for a commercial app; both commitments count toward usage. Only four regions are documented, cross-cloud Supabase egress remains, and a hard spend limit shuts down workloads. Healthchecks are deployment-time rather than continuous, logs retain 7/30 days on Hobby/Pro, and contractual SLA is Enterprise. |
| **Render web service + background worker** | Native Node and Docker. A web service receives HTTPS while a first-class worker continuously pulls without accepting inbound traffic. Same-region services share private networking, although the worker can initiate but not receive private requests. Deploys support health-gated web cutover, retained-artifact rollback, and `SIGTERM`; the default 30 s shutdown delay can be raised to 300 s before `SIGKILL`. | Strong direct PGMQ fit: the API enqueues and returns; a separate worker claims continuously. Shutdown must stop new claims and let unfinished work redeliver under the existing lease fence—Render does not replace completion-before-ack. | Minimum paid topology is two fixed 512 MiB Starter instances at **$14/month**. The production-oriented Pro workspace and its autoscaling raise the floor to **$39/month** before compute scale/egress; background workers have no free tier. Hobby/Pro include 5/25 GB bandwidth then charge $0.15/GB. Autoscaling is Pro+ and CPU/memory-based, not PGMQ-depth-based; each minimum instance is billed. |
| **Cloud Run service** | HTTPS container with request timeout up to 60 min. Request-based billing allocates CPU around requests; instance-based billing covers the full lifecycle. With minimum instances zero it scales to zero. | Strong for the API and an authenticated scheduled bounded-consume endpoint. It is not a continuously polling worker unless kept active through requests or instance-based execution. | Excellent low-volume economics and platform maturity. Requires GCP project, Artifact Registry/deploy, IAM, logging, and an external scheduler/wake-up; budgets alert rather than hard-stop, while max instances is a useful but imperfect spend guard. |
| **Cloud Run job** | One-off task execution; 10 min default and up to 168 h per task; always instance-based billing. Execution must be manual, scheduled, API-triggered, or orchestrated. | Long-job capable but weakly aligned: each PGMQ batch needs a trigger and job-execution control plane, while PGMQ still owns retry/lease/ack truth. | Low raw task compute, no permanent worker required, but more orchestration and slower startup than a bounded service request. |
| **Cloud Run worker pool** | Designed for continuous pull workers, with CPU allocated and billing while instances run. No native autoscaling and at least one instance is required while enabled. | Excellent runtime shape for PGMQ pulling. Native backlog scaling does not exist; PGMQ is not a CREMA source. | Warm floor plus manual scaling. CREMA or Google Workflows scaling adds a separate autoscaler/control plane, APIs, secrets, IAM, and custom PGMQ metric logic. |
| **Cloudflare Workers** | 128 MB isolate; paid CPU limits can fit orchestration but the measured Node/`tsx` proof peaked at 171.1 MiB and needs compatibility/bundle work. | Weak: no native PGMQ trigger, and adopting Cloudflare Queues would replace rather than preserve ADR-0007. | Assumed paid floor/usage about **$5 / $6.40**; not a valid cost comparison until a production bundle fits the isolate. Attractive only as a later thin edge adapter. |
| **Supabase Edge Functions** | Deno runtime; current documented 256 MB memory, 2 s CPU, and 400 s wall-clock limits. | Same provider, but the heavy Node dependency graph and CPU envelope do not map cleanly. PGMQ wake-up still needs an invocation path. | Assumed incremental invocations may remain inside plan quotas, but cost does not cure the runtime mismatch. Appropriate for small webhooks, not the durable pipeline proof. |
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
| Vercel Fluid | Low | Low on existing plan | Medium (13m20s GA; 30m beta) | Medium via HTTP wake-up | Low | Medium | Low |
| Vercel Workflows | Low/medium | Low/medium | Strong | Weak unless replacing PGMQ | Low after migration | High | Very high |
| **Railway** | Medium | Medium ($5 proof / $20 Pro commitment; warm worker) | Strong | **Strong** | **Low** | Low/medium | **Low** |
| **Render web + worker** | Medium | High ($14 compute / $39 Pro floor) | Strong | **Strong** | Low/medium | Low/medium | Low |
| Cloud Run service | Low | **Low** at min=0 | Strong (60m request) | Strong via HTTP wake-up | Medium | Medium | Medium |
| Cloud Run job | Low | Low | **Strong** (168h task) | Medium/weak | Medium/high | Medium | Medium/high |
| Cloud Run worker pool | Low/medium | Medium (warm floor) | Strong | **Strong** | High without custom autoscaling | Medium | Medium/high |
| Cloudflare Workers | Low | Low | Weak for current memory/runtime | Weak | Medium | High | High |
| Supabase Edge | Low | Low | Weak for current CPU/runtime | Weak | Low/medium | High | High |
| AWS Lambda | Low | **Low** | Medium/weak (15m cap) | Weak | Medium | High | Medium/high |
| AWS App Runner | Medium | Medium (warm floor) | Weak (120s HTTP) | Weak | Low | Medium | Ineligible/new customers |
| ECS Fargate | Medium | Medium/high | Strong | **Strong** | High | Medium | High |
| EC2 | Low at committed steady load | High | Strong | **Strong** | **Very high** | Low/medium | Very high |
| Amplify Hosting / Gen 2 | Low for frontend | Low for frontend | None as worker | None | Medium if backend adopted | High | Very high |

### Re-evaluated ranked recommendation

1. **Railway** remains the selected issue #196 target. The already-proved Node/Docker artifact maps
   directly, a persistent process can pull PGMQ, and the first migration adds the least infrastructure
   and engineering time. It is not the cheapest raw compute or broadest platform; its region,
   availability, observability, warm-floor, and spend-control gates remain mandatory.
2. **Render web service + background worker** is the closest operational alternative. Its explicit
   two-process model, Docker support, private network, retained-artifact rollback, and documented
   graceful shutdown make the deploy shape clearer than Railway's single generic service model.
   It does **not** make the domain safer—PGMQ, run-scoped RPCs, lease fencing, redelivery, and
   completion-before-ack do that—and it imposes a materially higher two-service floor ($14 paid
   compute; $39 with the Pro workspace), fixed instance sizing, and no queue-depth autoscaling.
3. **Cloud Run service** is the strongest scale-to-zero/mature-platform alternative. It offers a
   60-minute request limit and can preserve PGMQ through an authenticated bounded-consume endpoint,
   but adds GCP registry/IAM/logging/scheduler work; its continuous worker-pool shape has a warm floor
   and no native autoscaling.
4. **Vercel Fluid Compute** remains the lowest-migration interim API/bounded-attempt host. Longer
   current duration options remove the old categorical timeout objection, but the API must still
   enqueue and return and a separate PGMQ wake-up path remains.
5. **Vercel Workflows** is not a launch hosting seam. It is a credible future durability replacement,
   but layering its queue and persistence beside ADR-0007 would create two workflow truths.

Render therefore does not change the launch recommendation. It is easier than Cloud Run for a warm
two-process deployment and more explicit than Railway about worker lifecycle/rollback, but not
easier or safer enough for this repo to justify the higher fixed cost and extra service coordination.
ECS Fargate remains the strongest AWS fallback when organizational AWS controls justify its setup.

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
6. Operator approval for provider, plan, secrets, DNS, scheduler, and production traffic.
