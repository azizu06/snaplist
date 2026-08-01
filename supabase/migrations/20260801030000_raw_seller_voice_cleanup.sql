-- Issue #386: delete raw seller voice after terminal transcription or 24 hours.
--
-- Raw audio is temporary private transcription input. #541 bound the receipt to
-- the durable item run and left deletion pending here. Deletion stays two phase
-- like every other Storage removal: a short database transaction proves exactly
-- which object is eligible, and a separately leased capability removes it and
-- returns the completion proof named by docs/contracts/lean-mvp-retention-v1.json.
--
-- No transcription adapter, schedule, credential, hosted resource, or provider
-- call is created here.

-- Raw audio joins the existing cleanup sources rather than replacing them; the
-- guest sources #175 added stay allowed.
alter table private.pipeline_storage_cleanup_jobs
  drop constraint pipeline_storage_cleanup_source_check;
alter table private.pipeline_storage_cleanup_jobs
  add constraint pipeline_storage_cleanup_source_check check (
    source_type in (
      'staging', 'abandoned_item', 'guest_recovery', 'guest_claim_copy',
      'raw_voice'
    )
  );

alter table private.mobile_item_submission_voice_handoffs
  add column transcription_outcome text,
  add column transcription_outcome_at timestamptz,
  add column raw_audio_cleanup_queued_at timestamptz,
  add column raw_audio_deleted_at timestamptz,
  add constraint mobile_item_submission_voice_handoffs_outcome_check check (
    (transcription_outcome is null and transcription_outcome_at is null)
    or (
      transcription_outcome in (
        'transcribed', 'empty', 'unsupported', 'timed-out', 'failed'
      )
      and transcription_outcome_at is not null
    )
  ),
  -- The contract ceiling is 24 hours after durable acceptance. Staging anchors
  -- the existing deadline and never runs later than acceptance, so this holds by
  -- construction; the constraint keeps it machine-checked rather than asserted.
  add constraint mobile_item_submission_voice_handoffs_ceiling_check check (
    accepted_at is null
    or cleanup_after <= accepted_at + interval '24 hours'
  );

comment on column private.mobile_item_submission_voice_handoffs.raw_audio_deleted_at is
  'Completion proof for the private-storage-raw-voice retention row: the leased cleanup capability removed the object and an independent read proved it absent.';

create unique index mobile_item_submission_voice_handoffs_run_key
  on private.mobile_item_submission_voice_handoffs (run_id)
  where run_id is not null;

-- Both deletion triggers and the ceiling publish the same work, so they share
-- one shape. A raw voice job that dead-lettered is revived rather than skipped:
-- `do nothing` would leave the object present with `raw_audio_deleted_at` null
-- forever, and the retention contract has no way to resolve a row whose executor
-- has quietly stopped trying.
create or replace function private.queue_raw_seller_voice_cleanup(
  p_user_id text,
  p_idempotency_key uuid,
  p_cleanup_id uuid,
  p_storage_path text
)
returns boolean
language plpgsql
as $$
declare
  v_queued boolean;
begin
  insert into private.pipeline_storage_cleanup_jobs as job (
    source_type,
    source_id,
    photo_paths
  ) values (
    'raw_voice',
    p_cleanup_id,
    array[p_storage_path]
  )
  on conflict (source_type, source_id) do update
  set state = 'pending',
      attempt_count = 0,
      available_at = statement_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      safe_error = null,
      updated_at = statement_timestamp()
  where job.state = 'dead'
  returning true into v_queued;

  update private.mobile_item_submission_voice_handoffs handoff
  set raw_audio_cleanup_queued_at = coalesce(
        handoff.raw_audio_cleanup_queued_at,
        statement_timestamp()
      ),
      updated_at = statement_timestamp()
  where handoff.user_id = p_user_id
    and handoff.idempotency_key = p_idempotency_key;

  return coalesce(v_queued, false);
end;
$$;

revoke all on function private.queue_raw_seller_voice_cleanup(text, uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- The first durable terminal transcription outcome is the deletion trigger. A
-- later outcome, a redelivered queue message, or a replayed worker attempt is
-- the same logical run and must not queue a second deletion or rewrite history.
create or replace function public.record_raw_seller_voice_transcription_outcome(
  p_user_id text,
  p_run_id uuid,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff private.mobile_item_submission_voice_handoffs%rowtype;
  v_storage_path text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_outcome is null
    or p_outcome not in (
      'transcribed', 'empty', 'unsupported', 'timed-out', 'failed'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid seller voice transcription outcome';
  end if;
  if coalesce(p_user_id, '') = '' or p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid seller voice transcription identity';
  end if;

  select handoff.* into v_handoff
  from private.mobile_item_submission_voice_handoffs handoff
  where handoff.user_id = p_user_id
    and handoff.run_id = p_run_id
    and handoff.state = 'accepted'
  for update;
  if not found then
    return false;
  end if;
  if v_handoff.transcription_outcome is not null
    or v_handoff.raw_audio_deleted_at is not null then
    return false;
  end if;

  v_storage_path := v_handoff.receipt->>'storage_path';
  perform private.queue_raw_seller_voice_cleanup(
    v_handoff.user_id,
    v_handoff.idempotency_key,
    v_handoff.cleanup_id,
    v_storage_path
  );

  update private.mobile_item_submission_voice_handoffs handoff
  set transcription_outcome = p_outcome,
      transcription_outcome_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where handoff.user_id = v_handoff.user_id
    and handoff.idempotency_key = v_handoff.idempotency_key;
  return true;
end;
$$;

revoke all on function public.record_raw_seller_voice_transcription_outcome(
  text, uuid, text
) from public, anon, authenticated;
grant execute on function public.record_raw_seller_voice_transcription_outcome(
  text, uuid, text
) to service_role;

-- The 24 hour ceiling is a backstop, not a schedule. It queues deletion for raw
-- audio whose transcription never reached a terminal outcome, including a staged
-- upload whose submission was never accepted, once that upload's deadline has
-- lapsed. A client actively replaying the same stage refreshes that deadline by
-- #541's design, so the sweep reaches an upload the client has stopped touching,
-- not one still in flight.
--
-- Item deletion and guest recovery expiry have no leaf deletion capability
-- anywhere in the repository to hook into, so for those two triggers this sweep
-- is the executor and the ceiling is the bound. Account erasure does have the
-- #384 leaf shape, and raw audio contributes one below rather than making an
-- erased tenant wait out the ceiling.
create or replace function public.prepare_raw_seller_voice_retention(
  p_batch_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff record;
  v_queued integer := 0;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_batch_size not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'Raw seller voice retention batch size must be between 1 and 100';
  end if;

  -- A short preparation transaction keeps two maintenance requests from racing
  -- to publish the same deletion. The Storage phase is never under this lock.
  if not pg_try_advisory_xact_lock(
    hashtextextended('snaplist:raw-seller-voice-retention', 0)
  ) then
    return jsonb_build_object('rawVoiceJobsQueued', 0, 'skippedForLock', true);
  end if;

  for v_handoff in
    select handoff.user_id,
           handoff.idempotency_key,
           handoff.cleanup_id,
           handoff.receipt->>'storage_path' as storage_path
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.raw_audio_deleted_at is null
      and handoff.cleanup_after <= statement_timestamp()
    order by handoff.cleanup_after, handoff.cleanup_id
    for update skip locked
    limit p_batch_size
  loop
    if private.queue_raw_seller_voice_cleanup(
      v_handoff.user_id,
      v_handoff.idempotency_key,
      v_handoff.cleanup_id,
      v_handoff.storage_path
    ) then
      v_queued := v_queued + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'rawVoiceJobsQueued', v_queued,
    'skippedForLock', false
  );
end;
$$;

revoke all on function public.prepare_raw_seller_voice_retention(integer)
  from public, anon, authenticated;
grant execute on function public.prepare_raw_seller_voice_retention(integer)
  to service_role;

-- Issue #384 leaf capability for the private-storage-raw-voice retention row.
-- Erasure cannot wait out the ceiling, so it publishes deletion for every one of
-- the tenant's undeleted objects immediately. It reports `complete` only when
-- every handoff already carries its named proof: a queued job is scheduled work,
-- not a finished deletion, and the orchestrator must not report otherwise.
create or replace function public.delete_raw_seller_voice_for_account_erasure(
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff record;
  v_queued integer := 0;
  v_remaining integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if nullif(btrim(p_user_id), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Account erasure tenant is required';
  end if;

  for v_handoff in
    select handoff.user_id,
           handoff.idempotency_key,
           handoff.cleanup_id,
           handoff.receipt->>'storage_path' as storage_path
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.user_id = p_user_id
      and handoff.raw_audio_deleted_at is null
    order by handoff.cleanup_id
    for update
  loop
    if private.queue_raw_seller_voice_cleanup(
      v_handoff.user_id,
      v_handoff.idempotency_key,
      v_handoff.cleanup_id,
      v_handoff.storage_path
    ) then
      v_queued := v_queued + 1;
    end if;
  end loop;

  select count(*)::integer into v_remaining
  from private.mobile_item_submission_voice_handoffs handoff
  where handoff.user_id = p_user_id
    and handoff.raw_audio_deleted_at is null;

  return jsonb_build_object(
    'queued_count', v_queued,
    'remaining_count', v_remaining,
    'complete', v_remaining = 0
  );
end;
$$;

comment on function public.delete_raw_seller_voice_for_account_erasure(text) is
  'Issue #386 leaf capability: account erasure publishes raw seller audio deletion for the tenant and reports complete only once every object carries its named absence proof.';

revoke all on function public.delete_raw_seller_voice_for_account_erasure(text)
  from public, anon, authenticated;
grant execute on function public.delete_raw_seller_voice_for_account_erasure(text)
  to service_role;

-- The executor must be able to tell raw seller audio apart from photo cleanup:
-- raw voice is the one datum whose completion proof requires an independent
-- absence read, so the claim now names the source. Behavior is otherwise the
-- #162/#346 claim unchanged.
create or replace function public.claim_pipeline_storage_cleanup(
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_lease_seconds not between 30 and 3600 then
    raise exception using
      errcode = '22023',
      message = 'Pipeline cleanup lease must be between 30 and 3600 seconds';
  end if;

  -- A crash during the final allowed attempt is a dead letter after expiry.
  update private.pipeline_storage_cleanup_jobs job
  set state = 'dead',
      lease_token = null,
      lease_expires_at = null,
      safe_error = coalesce(job.safe_error, 'Photo cleanup lease expired.'),
      updated_at = statement_timestamp()
  where job.state = 'running'
    and job.lease_expires_at <= statement_timestamp()
    and job.attempt_count >= job.max_attempts;

  select * into v_job
  from private.pipeline_storage_cleanup_jobs job
  where (
      job.state = 'pending'
      and job.available_at <= statement_timestamp()
    ) or (
      job.state = 'running'
      and job.lease_expires_at <= statement_timestamp()
      and job.attempt_count < job.max_attempts
    )
  order by job.available_at, job.created_at, job.job_id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('kind', 'empty');
  end if;

  update private.pipeline_storage_cleanup_jobs job
  set state = 'running',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp()
        + make_interval(secs => p_lease_seconds),
      safe_error = null,
      updated_at = statement_timestamp()
  where job.job_id = v_job.job_id
  returning * into v_job;

  return jsonb_build_object(
    'kind', 'claimed',
    'job', jsonb_build_object(
      'jobId', v_job.job_id,
      'leaseToken', v_job.lease_token,
      'sourceType', v_job.source_type,
      'photoPaths', to_jsonb(v_job.photo_paths),
      'attemptCount', v_job.attempt_count,
      'maxAttempts', v_job.max_attempts
    )
  );
end;
$$;

revoke all on function public.claim_pipeline_storage_cleanup(integer)
  from public, anon, authenticated;
grant execute on function public.claim_pipeline_storage_cleanup(integer)
  to service_role;

-- Completion is the only place a deletion may be reported. For raw seller voice
-- it also stamps the completion proof named by the retention contract, so a
-- failed or abandoned attempt can never look like a finished deletion.
create or replace function public.complete_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_probe private.pipeline_storage_cleanup_jobs%rowtype;
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
  v_submission_probe private.mobile_item_submissions%rowtype;
  v_submission private.mobile_item_submissions%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;

  select job.* into v_probe
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id;
  if not found then return false; end if;

  if v_probe.source_type = 'staging'
    and v_probe.fence_generation is not null then
    select submission.* into v_submission_probe
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id;
    if not found then return false; end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        'mobile-item-submission:'
          || v_submission_probe.user_id || ':'
          || v_submission_probe.idempotency_key::text,
        0
      )
    );

    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id
      and submission.user_id = v_submission_probe.user_id
      and submission.idempotency_key = v_submission_probe.idempotency_key
    for update;
    if not found then return false; end if;
  end if;

  select job.* into v_job
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  if v_job.source_type = 'staging'
    and v_job.fence_generation is not null then
    if v_job.delete_authorized_at is null
      or v_submission.state is distinct from 'uploading'
      or v_submission.cleanup_id is distinct from v_job.source_id
      or v_submission.cleanup_generation
        is distinct from v_job.fence_generation then
      return false;
    end if;

    delete from private.pipeline_storage_cleanup_jobs job
    where job.job_id = v_job.job_id
      and job.lease_token = p_lease_token;
    if not found then return false; end if;

    delete from private.mobile_item_submissions submission
    where submission.user_id = v_submission.user_id
      and submission.idempotency_key = v_submission.idempotency_key
      and submission.cleanup_id = v_job.source_id
      and submission.state = 'uploading'
      and submission.cleanup_generation = v_job.fence_generation;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'Authenticated guest retention ledger completion was lost';
    end if;
    return true;
  end if;

  if v_job.source_type = 'guest_claim_copy'
    and v_job.resweep_requested
    and not v_job.guest_copy_final_sweep_armed then
    update private.pipeline_storage_cleanup_jobs job
    set state = 'pending',
        attempt_count = greatest(0, v_job.max_attempts - 1),
        available_at = statement_timestamp() + interval '5 minutes',
        lease_token = null,
        lease_expires_at = null,
        resweep_requested = false,
        guest_copy_final_sweep_armed = true,
        safe_error = null,
        updated_at = statement_timestamp()
    where job.job_id = v_job.job_id;
    return true;
  end if;

  if v_job.source_type = 'guest_claim_copy'
    and not v_job.guest_copy_writer_quiesced then
    if v_job.attempt_count >= v_job.max_attempts then
      update private.pipeline_storage_cleanup_jobs job
      set state = 'dead',
          lease_token = null,
          lease_expires_at = null,
          safe_error = 'Guest claim copy cleanup requires reconciliation.',
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    else
      update private.pipeline_storage_cleanup_jobs job
      set state = 'pending',
          available_at = statement_timestamp() + interval '5 minutes',
          lease_token = null,
          lease_expires_at = null,
          resweep_requested = false,
          safe_error = null,
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    end if;
    return true;
  end if;

  delete from private.pipeline_storage_cleanup_jobs job
  where job.job_id = v_job.job_id;
  if not found then
    return false;
  end if;

  -- Raw seller audio is the one source whose retention row names an absent
  -- object as its completion proof, so record it here: the executor has already
  -- removed the object and read it back, and this is the only place a deletion
  -- may be reported at all.
  if v_job.source_type = 'raw_voice' then
    update private.mobile_item_submission_voice_handoffs handoff
    set raw_audio_deleted_at = coalesce(
          handoff.raw_audio_deleted_at,
          statement_timestamp()
        ),
        updated_at = statement_timestamp()
    where handoff.cleanup_id = v_job.source_id;
  end if;
  return true;
end;
$$;

revoke all on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  to service_role;
