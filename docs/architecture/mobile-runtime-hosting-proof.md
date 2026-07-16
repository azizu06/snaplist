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
| `GET /api/ebay/connect`, `GET /api/ebay/callback` | Next cookie/redirect state around shared eBay modules | Server-owned OAuth session/callback; provider tokens never transit SwiftUI |
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
```

Container:

```bash
docker build -f Dockerfile.mobile-runtime-proof -t snaplist-mobile-runtime-proof .
docker run --rm --network none snaplist-mobile-runtime-proof
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

These are startup/transport measurements, not listing-pipeline latency. `tsx` is a development
loader rather than the future production bundle, so the decision uses **256 MiB as the minimum
candidate** and **512 MiB as the cost-model target** until a production artifact is profiled.

Live provider acceptance was prohibited. Therefore no honest measured model-stage p50/p95 exists in
this issue. The current code supplies only a **300-second design envelope**: both the Next route
maximum and default queue visibility/lease are 300 seconds, renewed at checkpoints. The cost model
uses a clearly labeled scenario of 120 seconds wall time, 10 seconds active CPU, and 512 MiB per item;
30/120/300-second sensitivity must be replaced by observed p50/p95 before hosted cutover.

## Current hosting comparison

Cost scenario (not measured model latency): **pilot** = 100 items, 2,000 API calls, 1 GB response
egress/month; **growth** = 10,000 items, 200,000 API calls, 20 GB response egress/month; each item =
120 seconds wall, 10 seconds active CPU, 512 MiB. Prices are US-region public list prices checked
2026-07-16. They exclude AI/search providers, Supabase base plan/storage/database egress, logs,
builds, tax, and support.

| Host | Runtime fit and limits | Operations / cold start | Pilot / growth scenario | Egress | Migration effort |
| --- | --- | --- | --- | --- | --- |
| **Vercel Fluid** | Native Node; Hobby max 300 s, Pro max 800 s; 2 GB Hobby memory | Very low ops; scales down and cold starts remain possible, with Fluid mitigations | Raw IAD compute about **$0.05 / $5.33**, generally inside plan inclusions; plan charges separate | 100 GB Hobby / 1 TB Pro included, then from $0.15/GB | Lowest for current web API; worker still request-duration-coupled |
| **Railway (recommended)** | Native Node/Docker; long-running process, no function-duration ceiling | Low ops; warm service has no cold boot; optional sleep after 10 outbound-idle minutes adds wake delay and may be defeated by DB/telemetry traffic | One warm 0.5 GB service is about **$5.05 / $6.19** under the scenario, with the $5 Hobby minimum counting toward usage | **$0.05/GB** | Low; run the proven artifact, add concrete auth/config, staging, and cutover |
| **Cloudflare Workers** | 128 MB isolate; Paid max 5 min CPU per HTTP request and 15 min Queue/Cron CPU; Node compatibility work required | Excellent global edge and fast startup; isolate constraints | Paid floor/usage about **$5 / $6.40**; not meaningful for the current worker because memory fit is unproven and the measured dev RSS exceeds 128 MB | No Workers egress charge | Medium/high; bundle/runtime/storage/photo path changes |
| **Supabase Edge** | Deno runtime; current docs report 250 MB and 2 s CPU resource limits; 400 s isolate wall clock | Low platform count, but cold starts possible; docs direct heavy jobs to background workers | Invocation increment **$0 / $0** within Free/Pro quotas; cost does not cure runtime mismatch | Unified quota; Pro 250 GB then $0.09/GB uncached | High; Deno/dependency migration and tighter CPU/memory budget |
| **AWS Lambda** | Node; 900 s max, up to 10,240 MB | Mature autoscaling, IAM/CloudWatch/VPC complexity, cold starts | At 512 MB × 120 s: **$0 / about $3.33** after the 400,000 GB-s free tier; requests remain within 1M | 100 GB AWS-wide outbound included, then regional rates | Medium/high; packaging, IAM, networking, observability, scheduler |
| **AWS App Runner** | Native container; warm 0.25 vCPU/0.5 GB minimum option | Managed container with provisioned warm memory and automatic scaling | About **$2.61 / $7.89** for 0.5 GB provisioned plus active 0.25 vCPU in the scenario | AWS transfer/log charges; 100 GB AWS-wide outbound included | Medium; good parity, more platform surface than Railway |

The strongest reason for Railway is runtime fit and migration locality, not a fragile dollar lead.
Lambda can be cheaper at the modeled volume and App Runner is a credible container alternative, but
both add operational depth SnapList does not yet need. Cloudflare remains attractive for a thin edge
front door only after the trusted Node modules are stable; Supabase Edge remains appropriate for
small webhooks, not this worker.

All external compute still downloads photos/data from Supabase, so Supabase Storage/database egress
must be measured independently of the host's response-egress price.

## Pre-cutover evidence required from the migration owner

1. Production-built Node image peak RSS at idle and while processing 1–4 photos.
2. At least 30 representative offline/sandbox runs reporting stage p50/p95 wall time, active CPU,
   peak RSS, bytes read from Supabase, and bytes returned.
3. Timeout/restart/redelivery acceptance at 30, 120, and 300 seconds with stale-lease rejection.
4. Concrete Clerk JWT verification plus RLS two-tenant tests; no caller-supplied `user_id`.
5. Staging-only eBay/StoreKit/App Attest callback fixtures from their owning issues.
6. Operator approval for provider, plan, secrets, DNS, scheduler, and production traffic.
