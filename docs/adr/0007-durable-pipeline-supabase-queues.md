# ADR-0007 — Durable listing pipeline on Supabase Queues

- **Status:** Accepted (2026-07-14)
- **Deciders:** Aziz
- **Implemented by:** issue #158 (foundation) and issue #160 (worker), with UX completed by epic #157
- **Supersedes:** the RabbitMQ/Go sold-comps-only proposal in
  `docs/architecture/scraper-worker-spec.md`

## Context

Single-item and batch listing preparation currently run vision, pricing, listing generation, and
persistence inside the initiating request. Photos are durable first, but the processing lifetime is
still coupled to a browser request and a serverless invocation. The older worker proposal moved only
the sold-comps fetch into RabbitMQ and Go; it did not make the whole product pipeline recoverable and
would add a second runtime, broker, deploy surface, and result callback.

Supabase now provides Postgres-native Queues through PGMQ. A Basic Queue uses logged Postgres tables,
retains messages until explicit deletion or archival, and makes a claimed message temporarily
invisible with a visibility timeout. It fits the existing Supabase, RLS, Realtime, and TypeScript
stack without introducing another pipeline implementation.

## Decision

1. **Queue the whole listing-preparation run.** `pipeline_runs` is the durable, tenant-owned source of
   truth. It records the item/listing relationship, status, stage, attempts, idempotency key, bounded
   failure summary, and lifecycle timestamps. The queue is only a wake-up signal.

2. **Use one logged Supabase Basic Queue named `pipeline_jobs`.** The migration calls
   `pgmq.create`, not `create_unlogged`. Both `pgmq.q_pipeline_jobs` and
   `pgmq.a_pipeline_jobs` must have permanent/logged persistence. The queue stays outside the Data
   API: `pgmq_public` is not created or exposed, and raw PGMQ privileges are revoked from `anon`,
   `authenticated`, and `service_role`.

3. **The versioned message is identifiers-only.** Schema version 1 is exactly:

   ```json
   { "run_id": "uuid", "schema_version": 1 }
   ```

   The Zod schema is strict. Tenant ids, item ids, photos, signed URLs, secrets, seller copy, model
   output, and authorization claims do not belong in the queue.

4. **Use a transport-neutral adapter.** `PipelineQueue` has `enqueue`, visibility-timeout `claim`,
   visibility extension/defer, and explicit `ack` operations. The in-memory implementation provides
   deterministic offline/CI behavior, including redelivery after the visibility window. The
   Supabase implementation maps only to four fixed PGMQ RPC capabilities. It never uses destructive
   `pop`, which would make a worker crash an at-most-once loss. Retry backoff and checkpoint
   heartbeats use `pgmq.set_vt`; `pgmq.delete` happens only after durable success or terminal failure.

5. **Separate queue authority from tenant-domain authority.** Queue claim/ack needs internal
   authority, but that authority is not a generic service-role domain client. `service_role` has no
   direct `pipeline_runs` or raw `pgmq` privilege. The worker receives two narrow TypeScript
   capabilities:

   - the four queue RPCs; and
   - message-paired, lease-fenced worker RPCs that derive `user_id`, `item_id`, private photo paths,
     and seller configuration from the stored run/item relationship.

   No worker domain function accepts a caller-supplied tenant id. The privileged composition root
   encloses `createAdminClient()` and exposes only the fixed RPCs plus a photos-bucket-only download
   capability; pipeline domain code never receives a generic `.from()` surface.

6. **Enforce lifecycle legality in Postgres.** Statuses are `queued`, `running`, `retrying`,
   `succeeded`, `failed`, and `canceled`; stages are `queued`, `identifying`, `pricing`, `generating`,
   `persisting`, and `completed`. Check constraints enforce legal combinations and timestamp/attempt
   invariants. A trigger enforces the transition graph, monotonic attempts, immutable run identity,
   and non-regressing stages. `(user_id, idempotency_key)` is unique, and queue enqueue records one
   unique PGMQ message id so retries cannot create another run or message accidentally.

7. **Keep PGMQ 1.4/1.5 behavior compatible.** The fresh local Supabase reset for issue #158 runs
   PostgreSQL 17.6 with PGMQ 1.5.1 installed. Supabase's 2025 upgrade notice says older projects may
   remain on 1.4.4, while PGMQ 1.5 adds a `timestamptz` overload for `delay` and breaks implicit string
   casts. SnapList therefore requires PGMQ 1.4.4 or newer and always uses the two-argument
   `pgmq.send(queue_name, msg)` call form. Delayed retries will use run state and visibility semantics,
   not an untyped delay argument. The pgTAP contract verifies the installed version, the common
   two-argument call contract (an overload or defaulted delay), and a real send on every reset.

8. **Fence attempts and checkpoint reusable stage output.** A claim must match the run's stored
   `queue_message_id`; it increments a bounded attempt count and creates a lease token. Identification,
   pricing, and generation checkpoints are cumulative and validated before resume. A stale token
   cannot checkpoint, fail, or complete a run. Completion atomically updates the pre-staged item and
   upserts exactly one draft listing and prediction log for the run before the queue message is
   acknowledged. Terminal failures persist only bounded safe text and are then acknowledged.

## Consequences

- **Positive:** a run can outlive a tab, request, or worker invocation; redelivery is explicit and
  testable; no new broker/runtime is required; the adapter keeps offline tests fast.
- **Positive:** queue credentials cannot be repurposed as an unrestricted tenant-data client, and
  forged run/item/listing ownership fails in Postgres.
- **Trade-off:** the worker uses audited RPC capabilities for each domain operation. That is more
  deliberate than a generic admin client, but it keeps the security boundary reviewable.
- **Rollout:** issues #158 and #160 provide the foundation and protected bounded consumer. Issue #159
  owns staging, quota reservation, enqueue, and progress UX; #161 owns notifications/recovery; #162
  owns hosted Cron, retention, health, and observability. Hosted scheduling remains unactivated until
  its owner-controlled slice lands.

## References

- [Supabase Queues quickstart](https://supabase.com/docs/guides/queues/quickstart)
- [Supabase PGMQ API reference](https://supabase.com/docs/guides/queues/pgmq)
- [PGMQ v1.5.0 delay compatibility note](https://github.com/pgmq/pgmq/releases/tag/v1.5.0)
- [Supabase PGMQ 1.4.4 → 1.5.1 upgrade notice](https://supabase.com/changelog/39378-potential-breaking-change-in-pgmq-from-1-4-4-to-1-5-1-and-temporary-halt-on-upgr)
