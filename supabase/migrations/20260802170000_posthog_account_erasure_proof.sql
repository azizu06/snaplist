-- Issue #617: delete the PostHog person and historical account-linked events.
--
-- The provider deletion is asynchronous. Preserve the resolved PostHog UUID
-- before the external mutation so a retry can query deletion_status after the
-- person record itself is gone. A completed receipt keeps only the named proof
-- timestamp; the provider UUID is scrubbed with the other working identifiers.

alter table private.account_erasure_generations
  add column posthog_person_uuid uuid,
  add column posthog_person_and_events_deletion_proved_at timestamptz,
  add constraint account_erasure_generations_posthog_target_scrubbed
    check (
      status not in ('deletion_completed', 'deletion_completed_with_retained_records')
      or posthog_person_uuid is null
    ),
  add constraint account_erasure_generations_posthog_proof_shape
    check (
      posthog_person_and_events_deletion_proved_at is null
      or status in ('deletion_completed', 'deletion_completed_with_retained_records')
    );

comment on column private.account_erasure_generations.posthog_person_uuid is
  'Issue #617 retry target. Persisted before PostHog bulk deletion and scrubbed '
  'when the terminal erasure receipt is written.';
comment on column private.account_erasure_generations.posthog_person_and_events_deletion_proved_at is
  'Issue #617 named completion proof. Written only after person absence and '
  'completed historical-event deletion are both verified through PostHog.';

create or replace function private.account_erasure_payload(p_generation_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'generation_id', generation.generation_id,
    'status', generation.status,
    'retained_records', to_jsonb(generation.retained_records),
    'deferrals', to_jsonb(generation.deferrals),
    'attention_reasons', to_jsonb(generation.attention_reasons),
    'identity', case
      when generation.clerk_user_id is null then 'null'::jsonb
      else jsonb_build_object(
        'clerk_user_id', generation.clerk_user_id,
        'revenuecat_app_user_ids', to_jsonb(generation.revenuecat_app_user_ids),
        'posthog_person_uuid', to_jsonb(generation.posthog_person_uuid)
      )
    end,
    'storage_objects', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bucket_id', manifest.bucket_id,
          'object_name', manifest.object_name
        ) order by manifest.bucket_id, manifest.object_name
      )
      from private.account_erasure_storage_manifest manifest
      where manifest.generation_id = generation.generation_id
        and manifest.verified_absent_at is null
    ), '[]'::jsonb)
  )
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
$$;

-- Durable handoff before the provider mutation. A retry may repeat the same
-- UUID, but it can never replace the target with another PostHog person.
create function public.record_account_erasure_posthog_person_uuid(
  p_generation_id uuid,
  p_person_uuid uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
begin
  perform private.account_erasure_service_role_required();

  if p_person_uuid is null then
    raise exception using
      errcode = '22004',
      message = 'PostHog person UUID is required';
  end if;

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure generation not found';
  end if;
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Completed account erasure cannot accept a PostHog target';
  end if;
  if v_generation.clerk_user_id is null then
    raise exception using
      errcode = '55000',
      message = 'Account erasure provider identity is not ready';
  end if;
  if v_generation.posthog_person_uuid is not null
    and v_generation.posthog_person_uuid <> p_person_uuid then
    raise exception using
      errcode = '23505',
      message = 'Account erasure PostHog person UUID is already bound';
  end if;

  update private.account_erasure_generations
  set posthog_person_uuid = p_person_uuid,
      updated_at = statement_timestamp()
  where generation_id = p_generation_id
    and posthog_person_uuid is null;
end;
$$;

revoke all on function public.record_account_erasure_posthog_person_uuid(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_account_erasure_posthog_person_uuid(uuid, uuid)
  to service_role;

drop function public.finalize_account_erasure(uuid, boolean, boolean, text[]);

create function public.finalize_account_erasure(
  p_generation_id uuid,
  p_clerk_identity_absent boolean,
  p_revenuecat_customer_absent boolean,
  p_posthog_person_and_events_deletion_confirmed boolean,
  p_attention_reasons text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
begin
  perform private.account_erasure_service_role_required();

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure generation not found';
  end if;
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  perform private.lock_account_erasure(v_generation.user_id);
  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
  for update;
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  if cardinality(coalesce(p_attention_reasons, '{}'::text[])) > 0 then
    update private.account_erasure_generations
    set status = 'deletion_needs_attention',
        attention_reasons = p_attention_reasons,
        updated_at = statement_timestamp()
    where generation_id = p_generation_id;
    return private.account_erasure_payload(p_generation_id);
  end if;

  if not coalesce(p_posthog_person_and_events_deletion_confirmed, false) then
    raise exception using
      errcode = '55000',
      message = 'PostHog person and event deletion is not proved';
  end if;
  if not coalesce(p_clerk_identity_absent, false) then
    raise exception using
      errcode = '55000',
      message = 'Clerk identity absence is not proved';
  end if;
  if cardinality(v_generation.revenuecat_app_user_ids) > 0
    and not coalesce(p_revenuecat_customer_absent, false) then
    raise exception using
      errcode = '55000',
      message = 'RevenueCat customer absence is not proved';
  end if;

  if private.account_erasure_owned_row_count(v_generation.user_id) <> 0
    or exists (
      select 1 from storage.objects object
      where object.bucket_id in ('photos', 'message-photos')
        and split_part(object.name, '/', 1) = v_generation.user_id
    )
    or exists (
      select 1
      from private.account_erasure_storage_manifest manifest
      where manifest.generation_id = p_generation_id
        and manifest.verified_absent_at is null
    ) then
    raise exception using
      errcode = '55000',
      message = 'Mandatory account erasure work is incomplete';
  end if;

  delete from private.account_erasure_storage_manifest
  where generation_id = p_generation_id;

  update private.account_erasure_generations
  set status = case
        when cardinality(retained_records) > 0
          then 'deletion_completed_with_retained_records'
        else 'deletion_completed'
      end,
      user_id = null,
      idempotency_key = null,
      clerk_user_id = null,
      revenuecat_app_user_ids = '{}'::text[],
      posthog_person_uuid = null,
      posthog_person_and_events_deletion_proved_at = statement_timestamp(),
      deferrals = '{}'::text[],
      attention_reasons = '{}'::text[],
      completed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where generation_id = p_generation_id;

  return private.account_erasure_payload(p_generation_id);
end;
$$;

revoke all on function public.finalize_account_erasure(
  uuid, boolean, boolean, boolean, text[]
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_account_erasure(
  uuid, boolean, boolean, boolean, text[]
) to service_role;
