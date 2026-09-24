-- Guest recovery expiry must be able to scrub a photo set remapped by #638.
--
-- complete_pipeline_run_with_guest_recovery replaces the submitted plaintext
-- photo paths with their encrypted recovery envelopes and deliberately leaves
-- the credited legacy path digest (photo_set_fingerprint) on the submitted
-- paths. The 24-hour expiry scrub therefore can never match that digest against
-- the envelope paths, the immutability guard rejects it, and hourly maintenance
-- aborts before its later retention stages.
--
-- The guard keeps every existing requirement. A digest mismatch is excused only
-- for the settled reservation bound to a due, unclaimed recovery of this item
-- whose run carries the recovery identity, whose canonical photo identity still
-- matches the item, whose manifest is exactly the current photo set, and whose
-- exact cleanup job was staged in this transaction.

create or replace function private.guest_recovery_expiry_scrub_allowed(
  p_item public.items,
  p_reservation public.ai_item_credit_reservations
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.guest_draft_recoveries recovery
    join public.pipeline_runs run
      on run.id = recovery.pipeline_run_id
     and run.item_id = recovery.item_id
     and run.user_id = recovery.guest_user_id
     and run.recovery_id = recovery.id
    join private.pipeline_storage_cleanup_jobs cleanup_job
      on cleanup_job.source_type = 'guest_recovery'
     and cleanup_job.source_id = recovery.id
     and cleanup_job.photo_paths is not distinct from p_item.photos
     and cleanup_job.xmin = pg_current_xact_id()::xid
    where recovery.item_id = p_item.id
      and recovery.guest_user_id = p_item.user_id
      and recovery.reservation_id = p_reservation.id
      and recovery.pipeline_run_id = p_reservation.pipeline_run_id
      and recovery.state in ('claimable', 'copying')
      and recovery.expires_at <= statement_timestamp()
      and private.guest_manifest_source_paths(recovery.storage_manifest)
        is not distinct from p_item.photos
      and p_reservation.item_id = p_item.id
      and p_reservation.user_id = p_item.user_id
      and p_reservation.state = 'settled'
      and p_reservation.photo_identity_kind = p_item.photo_identity_kind
      and p_reservation.photo_identity_fingerprint
        = p_item.photo_identity_fingerprint
  )
$$;

revoke all on function private.guest_recovery_expiry_scrub_allowed(
  public.items, public.ai_item_credit_reservations
) from public, anon, authenticated, service_role;

create or replace function private.enforce_credited_item_photo_set_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_set_fingerprint text;
begin
  if new.photos is not distinct from old.photos then
    return new;
  end if;

  perform reservation.id
  from public.ai_item_credit_reservations reservation
  where reservation.item_id = old.id
    and reservation.user_id = old.user_id
  order by reservation.pipeline_run_id
  for update of reservation;

  if not found then
    return new;
  end if;

  if private.guest_claim_photo_remap_allowed(old, new)
    or private.guest_recovery_photo_remap_allowed(old, new) then
    return new;
  end if;

  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(old.photos)::text, 'UTF8')),
    'hex'
  );

  if new.photos = '{}'::text[]
    and not exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
        and (
          reservation.state = 'reserved'
          or (
            reservation.photo_set_fingerprint
              is distinct from v_photo_set_fingerprint
            and not private.guest_recovery_expiry_scrub_allowed(old, reservation)
          )
        )
    )
    and exists (
      select 1
      from private.pipeline_storage_cleanup_jobs cleanup_job
      where cleanup_job.source_type in ('abandoned_item', 'guest_recovery')
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.source_id = old.id)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and exists (
              select 1
              from private.guest_draft_recoveries recovery
              where recovery.id = cleanup_job.source_id
                and recovery.item_id = old.id
                and recovery.guest_user_id = old.user_id
            )
          )
        )
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.photo_paths is not distinct from old.photos)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and cleanup_job.photo_paths @> old.photos
          )
        )
        and cleanup_job.xmin = pg_current_xact_id()::xid
    ) then
    return new;
  end if;

  raise exception using
    errcode = '23514',
    message = 'A credited item photo set is immutable; start a new AI-item run';
end;
$$;

revoke all on function private.enforce_credited_item_photo_set_immutable()
  from public, anon, authenticated, service_role;
