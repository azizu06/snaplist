# Hosted queue recovery, 2026-10-01

## Frozen contract

Restore authenticated included-offer claim advancement and expose the verified
paid allowance that reservation actually spends after a fenced seller purchases
Pro. Owned surfaces: the existing included-offer queue claim RPC, verified
entitlement projection, owner-activated scheduler, and recovery runbook.
No native UI, model selection, Apple DeviceCheck bypass, credit grants, marketplace
publishing, or deletion of seller records. The direct-PR worker does not merge or
delegate review; Firstmate owns those gates. Review round: 0/3.

## Production diagnosis

At approximately 07:23Z:

- No `snaplist-included-offer-worker` job existed in `cron.job`.
- Three included-offer messages, created September 7, September 30, and October 1,
  each had `read_ct=0`. Their claims were `queued`.
- The ordinary pipeline worker was active every minute, returned HTTP 200 and
  `{"claimed":0,"succeeded":0,"retrying":0,"failed":0,"skipped":0}`, and had an
  empty queue. No run had been created in six hours.
- The 07:12:21Z keyboard submission was still `uploading`; all four photos existed
  in private Storage, but there was no item, run, reserved device claim, or paid
  allowance. Upload completion alone cannot pass the credit reservation gate.

Recent-merge inspection:

- https://github.com/azizu06/snaplist/pull/1176 changes wake admission and bounded
  consumer concurrency after durable acceptance, not the included-offer schedule
  or device fence. The stalled submission never reached acceptance.
- https://github.com/azizu06/snaplist/pull/1174 and
  https://github.com/azizu06/snaplist/pull/1177 change native sharing/eBay surfaces.
- https://github.com/azizu06/snaplist/pull/1181 changes paywall cadence copy.
- https://github.com/azizu06/snaplist/pull/1182 changes benchmark tooling/docs.
- https://github.com/azizu06/snaplist/pull/1184 was left untouched.

Activating the absent schedule exposed a second defect: PGMQ's ID ordering picked
the abandoned September 7 message on every minute tick. Its 35-second deferral
expired before the next tick; the worker kept reopening that claim, leaving newer
sellers unread. The SQL regression reproduced this exact redelivery pattern.

The RevenueCat handoff identified an adjacent purchase blocker. The entitlement
projection returned `included/included/1` even when reservation could not spend
that included period and would instead spend StoreKit. The native purchase
confirmation requires the server's active StoreKit projection. The public SQL
regression failed three assertions before the fix.

## Repair and prior configuration

Captain-authorized production repair:

1. Prior included-offer scheduler state: **absent**. Existing pipeline worker and
   maintenance schedules stayed active. Vault names
   `snaplist_pipeline_origin` and `snaplist_pipeline_cron_secret` were present;
   the origin was `https://snaplist.dev`. Secret contents were not logged or
   rotated.
2. At 07:24:47Z, registered the included-offer job at `* * * * *`, copying the
   active worker's existing Vault-based command and replacing only its route
   with `/api/internal/included-offer-worker`. First scheduled call at 07:25Z
   returned HTTP 200 with one opened claim.
3. Applied `20261001073019_queue_stall_recovery` to production at 07:30:19Z.
   It replaces only two function bodies and preserves their authorization and
   execution grants. Claims now sort by oldest eligibility time (`vt`, then
   message ID), atomically lock with `FOR UPDATE SKIP LOCKED`, and claim exactly
   one message. The worker's open-rendezvous check and singleton Apple writer
   lease remain unchanged.
4. A reachable verified StoreKit active/grace period now precedes an unreachable
   included run in the read projection. Guests, reserved/consumed claims,
   operator grants, and expired-paid behavior retain their existing precedence.
   Reservation, settlement, billing events, and device bits are unchanged.

After deployment, real fenced subscribers read `storekit/active` with their
verified remaining allowance. Claims previously never read began advancing;
all queue messages remain durable until the existing terminal acknowledgment.
Opening a claim is not redeeming it: the native client must supply a fresh
DeviceCheck token. No physical phone was controlled by this worker.

## Validation

TDD at the public SQL interfaces:

- `included_offer_queue_fairness.test.sql`: failed the abandoned-head test before
  the replacement; **6/6 passed** after it, including single-message bounds,
  null rejection, and seller-identity refusal.
- `entitlement_fenced_included_storekit.test.sql`: initially **3/9 failed** with
  the unreachable `included` projection; **12/12 passed** after the replacement.
  Coverage includes absent/existing included periods, queued/reserved/consumed
  claims, guest precedence, active/grace/expired StoreKit, and execution grants.
- Tests ran on an isolated Supabase PostgreSQL 17.6 container with real PGMQ and
  pgTAP, authoritative table constraints/function bodies extracted from the
  repository, and minimal unrelated authentication/pipeline scaffolding. This
  is focused SQL evidence, not a full local Supabase/RLS suite.
- Existing included-offer route, fence, HTTP, configuration, and Apple-adapter
  contract tests: **37 passed**. Typecheck and migration-version audit passed.

Hosted end-to-end test:

- Signed-in Chrome sent a fresh public Keychron stock photo to the hosted native
  multipart endpoint; no private seller media was copied into the test.
- `POST /v1/items/runs` returned **202** for run
  `32786829-6dfa-462a-b6ea-15f4f038ef14`, item
  `1bf1d020-3f86-4cb2-b5c0-f349259f3c45`, at 07:32:06.656931Z.
- The live worker completed at **07:32:48.725244Z** (42 seconds). Production
  readback showed one listing, one prediction ($29, confidence 0.56824), and one
  credit settled at 07:32:48.740806Z.
- Authenticated `GET /v1/runs/<run-id>` returned **200**, `succeeded/completed`.
  This proves hosted intake, durable execution, provider-backed value, and credit
  settlement. It does not prove a physical-device free redemption or purchase UI.

The maintenance route separately returned an HTTP 500 at 07:17Z. It did not
prevent the empty consumer from responding, nor the fresh hosted run from
completing; maintenance repair is outside this focused incident patch.

## Rollback and remaining evidence boundary

Disable only `snaplist-included-offer-worker` to restore the previous scheduler
state without deleting claims, runs, photos, or Vault entries. Previous function
bodies are in `20260731190000_included_offer_device_fence.sql` (queue claim) and
`20260909120000_operator_pro_allowance.sql` (entitlement); restoring them requires
an explicit forward rollback migration and reintroduces the reproduced defects.

The native redemption coordinator currently allows four follow-ups. A minute
scheduler can exceed that polling window, especially behind abandoned claims.
The scheduler/queue is now live; a separate bounded wake/poll-lifetime correction
may be needed for reliable first-attempt device redemption. Record actual phone
redemption/purchase evidence through its owning worker before claiming that
on-device boundary is complete.
