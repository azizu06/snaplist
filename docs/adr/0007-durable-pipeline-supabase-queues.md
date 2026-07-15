# ADR-0007 — Durable listing pipeline on Supabase Queues

- **Status:** Accepted (2026-07-14)
- **Deciders:** Aziz
- **Implemented by:** issue #158 (foundation), with execution and UX completed by epic #157
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
   and explicit `ack` operations. The in-memory implementation provides deterministic offline/CI
   behavior, including redelivery after the visibility window. The Supabase implementation maps
   only to three fixed PGMQ RPC capabilities. It never uses destructive `pop`, which would make a
   worker crash an at-most-once loss.

5. **Separate queue authority from tenant-domain authority.** Queue claim/ack needs internal
   authority, but that authority is not a generic service-role domain client. `service_role` has no
   direct `pipeline_runs` or raw `pgmq` privilege. The worker receives two narrow TypeScript
   capabilities:

   - the three queue RPCs; and
   - run-scoped worker RPCs that accept a trusted `run_id`, derive `user_id` and `item_id` from the
     stored run, and validate an optional listing through composite ownership foreign keys.

   No worker domain function accepts a caller-supplied tenant id. Future worker persistence must
   extend this audited run-derived RPC boundary (or use a real tenant JWT/RLS client); it must not
   receive `createAdminClient()` or a generic `.from()` surface.

6. **Enforce lifecycle legality in Postgres.** Statuses are `queued`, `running`, `retrying`,
   `succeeded`, `failed`, and `canceled`; stages are `queued`, `identifying`, `pricing`, `generating`,
   `persisting`, and `completed`. Check constraints enforce legal combinations and timestamp/attempt
   invariants. A trigger enforces the transition graph, monotonic attempts, immutable run identity,
   and non-regressing stages. `(user_id, idempotency_key)` is unique, and queue enqueue records one
   unique PGMQ message id so retries cannot create another run or message accidentally.

7. **Keep PGMQ 1.4/1.5 behavior compatible.** The fresh local Supabase reset for issue #158 runs
   PostgreSQL 17.6 with PGMQ 1.5.1 installed. Supabase's 2025 upgrade notice says older projects may
   remain on 1.4.4, while PGMQ 1.5 adds a `timestamptz` overload for `delay` and breaks implicit string
   casts. SnapList therefore requires PGMQ 1.4.4 or newer and always calls the two-argument
   `pgmq.send(queue_name, msg)` form. Delayed retries will use run state and visibility semantics,
   not an untyped delay argument. The pgTAP contract verifies the installed version, the common
   two-argument signature, and a real send on every reset.

## Consequences

- **Positive:** a run can outlive a tab, request, or worker invocation; redelivery is explicit and
  testable; no new broker/runtime is required; the adapter keeps offline tests fast.
- **Positive:** queue credentials cannot be repurposed as an unrestricted tenant-data client, and
  forged run/item/listing ownership fails in Postgres.
- **Trade-off:** the worker uses audited RPC capabilities for each domain operation. That is more
  deliberate than a generic admin client, but it keeps the security boundary reviewable.
- **Rollout:** issue #158 creates the foundation only. Upload, batch, worker routing, notifications,
  retry/cancel UI, Cron activation, and retention remain owned by the later #157 child issues. Until
  those land, production request behavior remains synchronous.

## References

- [Supabase Queues quickstart](https://supabase.com/docs/guides/queues/quickstart)
- [Supabase PGMQ API reference](https://supabase.com/docs/guides/queues/pgmq)
- [PGMQ v1.5.0 delay compatibility note](https://github.com/pgmq/pgmq/releases/tag/v1.5.0)
- [Supabase PGMQ 1.4.4 → 1.5.1 upgrade notice](https://supabase.com/changelog/39378-potential-breaking-change-in-pgmq-from-1-4-4-to-1-5-1-and-temporary-halt-on-upgr)
