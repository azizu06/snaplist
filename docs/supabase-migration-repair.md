# Supabase migration-version repair runbook

Issue #142 preserves every existing migration's SQL while giving each migration
file a unique version. It fixes the duplicate that blocks local reset and
reserves `20260714180000` for the message-photo migration in PR #146 after that
PR rebases onto this change.

## Canonical migration versions

| Previous file | Canonical file | Why |
| --- | --- | --- |
| `20260713220000_ebay_message_lifecycle_server_control.sql` | unchanged | Retains the lifecycle-control migration at its established version. |
| `20260713220000_outbound_price_revision_guards.sql` | `20260713220100_outbound_price_revision_guards.sql` | Runs one minute after lifecycle control and before the existing `20260713230000` migration. |
| `20260714180000_billing_customer_lifecycle.sql` | `20260714180100_billing_customer_lifecycle.sql` | Frees `20260714180000` for PR #146's unchanged `message_photo_attachments` migration; billing follows it by one minute. |

The renamed files are byte-for-byte unchanged. The filename-only move preserves
their applied SQL semantics; fresh databases replay lifecycle control, outbound
guards, message photos (after #146 rebases), then billing in that order.

## Fresh local verification

From the repository root, run:

```sh
pnpm audit:migrations
pnpm supabase db reset --local
```

The audit fails on malformed filenames or duplicate 14-digit versions. A reset
must complete before any local integration test is considered valid.

## Existing linked environments

This pull request does not run a linked command or mutate a hosted database.
An operator should use a maintenance window, take the normal project backup,
and first inspect migration history without changing it:

```sh
pnpm supabase migration list --linked
```

For an environment that might have encountered the `20260713220000` collision,
inspect the actual schema before choosing a path. The following read-only query
distinguishes the two SQL shapes that previously shared the same history key:

```sql
select
  to_regprocedure('private.enforce_message_reply_marketplace_coherence()') is not null
    as lifecycle_control_present,
  to_regprocedure('public.begin_ebay_publish(uuid, uuid, uuid)') is not null
    as outbound_publish_guard_present,
  to_regprocedure('public.persist_export_packs(uuid, uuid, uuid, jsonb)') is not null
    as outbound_export_guard_present;
```

| Observed state | Safe next action |
| --- | --- |
| `20260713220000` is absent | Review `pnpm supabase db push --linked --dry-run`, then apply the normal push. |
| `20260713220000` is recorded; lifecycle control is present; both outbound guards are absent | Review the dry run. It must include `20260713220100_outbound_price_revision_guards.sql` and may include later migrations that were never reached after the collision; verify every listed version against the expected history, then run the normal push. |
| `20260713220000` is recorded and all three functions are present | The outbound SQL already landed but its new history key did not. In the maintenance window, record only the renamed version: `pnpm supabase migration repair --status applied 20260713220100 --linked`. Re-run `migration list` afterward. |
| Any other combination | Stop. Do not guess which SQL owned the old version or mark history blindly; restore/clone the database and reconcile it with the owner. |

### Billing version before PR #146 lands

If an existing environment has the billing SQL and records the old
`20260714180000` version, verify `public.billing_customers` exists, then use a
maintenance window to rename its history record without rerunning billing SQL:

```sql
select to_regclass('public.billing_customers') is not null as billing_customers_present;
```

```sh
pnpm supabase migration repair --status reverted 20260714180000 --linked
pnpm supabase migration repair --status applied 20260714180100 --linked
pnpm supabase migration list --linked
```

Do not run that pair when `20260714180000` represents any other migration or
when `billing_customers` is absent. Escalate instead. After PR #146 rebases onto
the repaired main branch, its photo migration legitimately owns
`20260714180000`; use `--include-all` because that newly introduced version
sorts before the already-recorded billing version:

```sh
pnpm supabase db push --linked --include-all --dry-run
# Confirm the only pending migration is 20260714180000_message_photo_attachments.sql.
pnpm supabase db push --linked --include-all
```

The dry run is the approval point. If it lists any unexpected migration, stop
and investigate rather than applying it.
