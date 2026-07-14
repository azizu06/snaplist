-- Issue #135: opt-in, fact-grounded pre-sale automatic replies.
--
-- Authorization is deliberately split from transport. This migration owns the
-- tenant preference, once-per-policy-version decision audit, generation-bound
-- scheduler reads/writes, and a projection of canonical transport truth. The
-- existing eBay adapter and durable canonical-reply state machine remain the
-- only code allowed to contact the marketplace.

alter table public.user_settings
  add column if not exists auto_reply_enabled boolean not null default false;

comment on column public.user_settings.auto_reply_enabled is
  'Master opt-in for deterministic safe-fact pre-sale replies. False by default; no per-category rules.';

alter table public.messages
  add column if not exists policy_version text,
  add column if not exists policy_outcome text,
  add column if not exists policy_reason_codes text[] not null default '{}'::text[],
  add column if not exists policy_grounding_references jsonb not null default '[]'::jsonb,
  add column if not exists policy_safety_signals jsonb not null default '{}'::jsonb,
  add column if not exists policy_decided_at timestamptz;

create table public.message_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  message_id uuid not null,
  listing_id uuid not null,
  ebay_account_generation uuid not null,
  policy_version text not null,
  outcome text not null check (outcome in ('auto_send', 'draft_for_approval', 'escalate')),
  reason_codes text[] not null check (cardinality(reason_codes) > 0),
  grounding_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(grounding_references) = 'array'),
  safety_signals jsonb not null default '{}'::jsonb
    check (jsonb_typeof(safety_signals) = 'object'),
  proposed_reply text,
  draft_reply text not null,
  draft_model text not null,
  delivery_status text not null default 'not_attempted'
    check (delivery_status in (
      'not_attempted', 'not_applicable', 'pending', 'sending',
      'delivered', 'rejected', 'failed', 'ambiguous'
    )),
  external_delivery_id text,
  delivery_attempted_at timestamptz,
  delivered_at timestamptz,
  delivery_error text,
  decided_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint message_policy_decisions_message_user_fkey
    foreign key (message_id, user_id)
    references public.messages (id, user_id) on delete cascade,
  constraint message_policy_decisions_listing_user_fkey
    foreign key (listing_id, user_id)
    references public.listings (id, user_id) on delete cascade,
  unique (user_id, message_id, policy_version)
);

create index message_policy_decisions_pending_idx
  on public.message_policy_decisions (
    user_id, ebay_account_generation, policy_version, decided_at
  ) where outcome = 'auto_send' and delivery_status = 'not_attempted';

drop trigger if exists message_policy_decisions_set_updated_at
  on public.message_policy_decisions;
create trigger message_policy_decisions_set_updated_at
  before update on public.message_policy_decisions
  for each row execute function public.set_updated_at();

alter table public.message_policy_decisions enable row level security;

create policy message_policy_decisions_select_own
  on public.message_policy_decisions for select
  to authenticated
  using (public.clerk_user_id() = user_id);

revoke all on table public.message_policy_decisions from public, anon, authenticated;
grant select on table public.message_policy_decisions to authenticated;
revoke all on table public.message_policy_decisions from service_role;

comment on table public.message_policy_decisions is
  'Immutable authorization evidence per imported question and policy version. Writes are server RPC-only; delivery columns mirror canonical transport truth.';

create or replace function private.record_ebay_message_policy_decision_for_tenant(
  p_user_id text,
  p_message_id uuid,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_message public.messages%rowtype;
  v_existing public.message_policy_decisions%rowtype;
  v_inserted public.message_policy_decisions%rowtype;
  v_policy_version text := nullif(btrim(p_payload->>'policy_version'), '');
  v_outcome text := nullif(btrim(p_payload->>'outcome'), '');
  v_draft_reply text := nullif(btrim(p_payload->>'draft_reply'), '');
  v_draft_model text := nullif(btrim(p_payload->>'draft_model'), '');
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Policy decision payload is required';
  end if;
  if v_policy_version <> 'grounded-pre-sale-v1' then
    raise exception using errcode = '22023', message = 'Unsupported message policy version';
  end if;
  if v_outcome not in ('auto_send', 'draft_for_approval', 'escalate') then
    raise exception using errcode = '22023', message = 'Invalid message policy outcome';
  end if;
  if v_draft_reply is null or v_draft_model is null then
    raise exception using errcode = '22023', message = 'A durable draft and model provenance are required';
  end if;
  if jsonb_typeof(coalesce(p_payload->'reason_codes', 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_payload->'reason_codes') = 0
    or jsonb_typeof(coalesce(p_payload->'grounding_references', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload->'safety_signals', 'null'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Structured policy evidence is required';
  end if;
  if v_outcome = 'auto_send'
    and nullif(btrim(p_payload->>'proposed_reply'), '') is null then
    raise exception using errcode = '22023', message = 'Automatic replies require deterministic proposed text';
  end if;

  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.generation is distinct from p_generation then
    raise exception using errcode = '40001', message = 'eBay messaging account generation expired';
  end if;
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;

  select message.* into v_message
  from public.messages message
  where message.id = p_message_id
    and message.user_id = p_user_id
    and message.ebay_account_generation = p_generation
    and message.marketplace = 'ebay'
    and message.direction = 'inbound'
    and message.listing_id is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Imported buyer question was not found';
  end if;

  select decision.* into v_existing
  from public.message_policy_decisions decision
  where decision.user_id = p_user_id
    and decision.message_id = p_message_id
    and decision.policy_version = v_policy_version;
  if found then
    return jsonb_build_object('inserted', false, 'decision', to_jsonb(v_existing));
  end if;
  if v_message.status <> 'drafting' then
    raise exception using errcode = '40001', message = 'Buyer question is no longer claimable';
  end if;

  insert into public.message_policy_decisions (
    user_id, message_id, listing_id, ebay_account_generation, policy_version,
    outcome, reason_codes, grounding_references, safety_signals,
    proposed_reply, draft_reply, draft_model, delivery_status
  ) values (
    p_user_id, p_message_id, v_message.listing_id, p_generation, v_policy_version,
    v_outcome,
    array(select jsonb_array_elements_text(p_payload->'reason_codes')),
    p_payload->'grounding_references',
    p_payload->'safety_signals',
    nullif(btrim(p_payload->>'proposed_reply'), ''),
    v_draft_reply,
    v_draft_model,
    case when v_outcome = 'auto_send' then 'not_attempted' else 'not_applicable' end
  ) returning * into v_inserted;

  update public.messages message
  set status = 'drafted',
      draft_reply = v_draft_reply,
      draft_model = v_draft_model,
      policy_version = v_policy_version,
      policy_outcome = v_outcome,
      policy_reason_codes = v_inserted.reason_codes,
      policy_grounding_references = v_inserted.grounding_references,
      policy_safety_signals = v_inserted.safety_signals,
      policy_decided_at = v_inserted.decided_at
  where message.id = p_message_id and message.user_id = p_user_id;

  return jsonb_build_object('inserted', true, 'decision', to_jsonb(v_inserted));
end;
$$;

revoke all on function private.record_ebay_message_policy_decision_for_tenant(
  text, uuid, jsonb, uuid
) from public, anon, authenticated, service_role;

create or replace function public.record_ebay_message_policy_decision(
  p_message_id uuid,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey', ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  return private.record_ebay_message_policy_decision_for_tenant(
    v_user_id, p_message_id, p_payload, p_generation
  );
end;
$$;

revoke all on function public.record_ebay_message_policy_decision(uuid, jsonb, uuid)
  from public, anon, service_role;
grant execute on function public.record_ebay_message_policy_decision(uuid, jsonb, uuid)
  to authenticated;

create or replace function public.record_scheduled_ebay_message_policy_decision(
  p_user_id text,
  p_message_id uuid,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  return private.record_ebay_message_policy_decision_for_tenant(
    p_user_id, p_message_id, p_payload, p_generation
  );
end;
$$;

revoke all on function public.record_scheduled_ebay_message_policy_decision(
  text, uuid, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.record_scheduled_ebay_message_policy_decision(
  text, uuid, jsonb, uuid
) to service_role;

create or replace function public.read_scheduled_ebay_message_policy(
  p_user_id text,
  p_operation text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  select account.* into v_account
  from private.ebay_messaging_account_generations account
  where account.user_id = p_user_id and account.seller_erased = false;
  if not found then
    raise exception using errcode = '42501', message = 'Seller messaging account is unavailable';
  end if;

  if p_operation = 'preference' then
    select to_jsonb(coalesce(settings.auto_reply_enabled, false)) into v_result
    from (select 1) singleton
    left join public.user_settings settings on settings.user_id = p_user_id;
    return v_result;
  elsif p_operation = 'grounding' then
    select jsonb_build_object('listing', to_jsonb(listing), 'item', to_jsonb(item))
    into v_result
    from public.messages message
    join public.listings listing
      on listing.id = message.listing_id and listing.user_id = message.user_id
    join public.items item
      on item.id = message.item_id and item.user_id = message.user_id
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.ebay_account_generation = v_account.generation;
    return v_result;
  elsif p_operation = 'pending_auto_send' then
    select coalesce(jsonb_agg(jsonb_build_object('messageId', pending.message_id)
      order by pending.decided_at), '[]'::jsonb)
    into v_result
    from public.message_policy_decisions pending
    join public.messages message
      on message.id = pending.message_id and message.user_id = pending.user_id
    join public.user_settings settings
      on settings.user_id = pending.user_id
      and settings.auto_reply_enabled = true
    where pending.user_id = p_user_id
      and pending.ebay_account_generation = v_account.generation
      and pending.policy_version = p_payload->>'policy_version'
      and pending.outcome = 'auto_send'
      and pending.delivery_status = 'not_attempted'
      and message.status = 'drafted';
    return v_result;
  elsif p_operation = 'delivery_root' then
    select to_jsonb(message) into v_result
    from public.messages message
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.ebay_account_generation = v_account.generation;
    return v_result;
  elsif p_operation = 'canonical_delivered' then
    select to_jsonb(reply) into v_result
    from public.messages reply
    where reply.reply_to = (p_payload->>'message_id')::uuid
      and reply.user_id = p_user_id
      and reply.ebay_account_generation = v_account.generation
      and reply.direction = 'outbound'
      and (reply.reply_kind is null or reply.reply_kind = 'reply')
      and reply.delivery_status = 'delivered'
      and reply.external_delivery_id is not null;
    return v_result;
  end if;
  raise exception using errcode = '22023', message = 'Unsupported scheduled policy read';
end;
$$;

revoke all on function public.read_scheduled_ebay_message_policy(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.read_scheduled_ebay_message_policy(text, text, jsonb)
  to service_role;

-- Project canonical transport changes onto the authorization audit. A failed or
-- ambiguous attempt stays retryable; only acknowledged canonical delivery is
-- recorded as delivered.
create or replace function private.sync_message_policy_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_root_id uuid;
begin
  if new.direction = 'outbound' and new.reply_to is not null
    and (new.reply_kind is null or new.reply_kind = 'reply') then
    v_root_id := new.reply_to;
  elsif new.direction = 'inbound' then
    v_root_id := new.id;
  else
    return new;
  end if;

  update public.message_policy_decisions decision
  set delivery_status = coalesce(new.delivery_status, decision.delivery_status),
      external_delivery_id = coalesce(new.external_delivery_id, decision.external_delivery_id),
      delivery_attempted_at = coalesce(new.delivery_attempted_at, decision.delivery_attempted_at),
      delivered_at = case
        when new.delivery_status = 'delivered' then coalesce(new.sent_at, statement_timestamp())
        else decision.delivered_at
      end,
      delivery_error = new.delivery_error
  where decision.user_id = new.user_id
    and decision.message_id = v_root_id
    and decision.policy_version = (
      select root.policy_version from public.messages root
      where root.id = v_root_id and root.user_id = new.user_id
    );
  return new;
end;
$$;

revoke all on function private.sync_message_policy_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists messages_sync_message_policy_delivery on public.messages;
create trigger messages_sync_message_policy_delivery
  after insert or update of delivery_status, external_delivery_id,
    delivery_attempted_at, delivery_error, sent_at
  on public.messages
  for each row execute function private.sync_message_policy_delivery();

-- The service-role scheduler may transport an authorized automatic reply, but
-- only via the same generation-bound durable canonical operations used by a
-- seller-approved reply. No provider or marketplace mutation is added here.
create or replace function private.apply_scheduled_ebay_message_write(
  p_user_id text,
  p_operation text,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  if p_operation not in (
    'sync_mark_attempt', 'sync_mark_success', 'sync_mark_failure',
    'upsert_unresolved_question', 'mark_unresolved_question_failed',
    'remove_unresolved_question', 'retire_unresolved_question',
    'mark_externally_answered', 'mark_provider_unavailable',
    'import_question', 'ensure_notification', 'claim_draft',
    'attach_draft', 'mark_draft_failed',
    'claim_canonical', 'begin_provider_dispatch', 'renew_provider_dispatch',
    'fail_canonical', 'complete_canonical'
  ) then
    raise exception using errcode = '42501', message = 'Scheduler operation is not allowed';
  end if;
  if p_operation in (
    'claim_canonical', 'begin_provider_dispatch', 'renew_provider_dispatch',
    'fail_canonical', 'complete_canonical'
  ) and not exists (
    select 1
    from public.message_policy_decisions decision
    join public.messages message
      on message.id = decision.message_id
      and message.user_id = decision.user_id
      and message.ebay_account_generation = decision.ebay_account_generation
    join public.user_settings settings
      on settings.user_id = decision.user_id
    where decision.user_id = p_user_id
      and decision.message_id = (p_payload->>'message_id')::uuid
      and decision.ebay_account_generation = p_generation
      and decision.policy_version = 'grounded-pre-sale-v1'
      and decision.outcome = 'auto_send'
      and message.policy_version = decision.policy_version
      and message.policy_outcome = 'auto_send'
      and message.draft_reply = decision.proposed_reply
      and (
        settings.auto_reply_enabled = true
        or p_operation in (
          'renew_provider_dispatch', 'fail_canonical', 'complete_canonical'
        )
      )
      and (
        p_operation not in ('claim_canonical', 'complete_canonical')
        or p_payload->>'body' = decision.proposed_reply
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Scheduler canonical delivery is not authorized by the current message policy';
  end if;
  v_result := private.apply_serialized_ebay_message_write_for_tenant(
    p_user_id, p_operation, p_payload, p_generation
  );
  if p_operation = 'upsert_unresolved_question' then
    perform private.record_unresolved_ebay_buyer_provenance(
      p_user_id, p_generation, p_payload
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) to service_role;
