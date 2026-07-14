insert into private.ebay_messaging_account_generations (user_id)
select distinct source.user_id
from (
  select user_id from public.ebay_connections
  union all
  select user_id from public.messages where marketplace = 'ebay'
  union all
  select user_id from public.ebay_unresolved_questions
  union all
  select user_id from public.ebay_message_sync_state
) source
where nullif(btrim(source.user_id), '') is not null
on conflict (user_id) do nothing;

create table if not exists private.ebay_seller_account_generations (
  user_id text not null,
  account_generation uuid not null,
  seller_erased boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  erased_at timestamptz,
  primary key (user_id, account_generation)
);

revoke all on table private.ebay_seller_account_generations
  from public, anon, authenticated, service_role;

insert into private.ebay_seller_account_generations (
  user_id,
  account_generation,
  seller_erased,
  erased_at
)
select account.user_id,
       account.generation,
       account.seller_erased,
       case when account.seller_erased then account.updated_at else null end
from private.ebay_messaging_account_generations account
on conflict (user_id, account_generation) do nothing;

create table if not exists private.ebay_provider_dispatch_leases (
  user_id text not null,
  message_id uuid not null,
  account_generation uuid not null,
  attempted_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, message_id)
);

revoke all on table private.ebay_provider_dispatch_leases
  from public, anon, authenticated, service_role;

create or replace function private.expire_ebay_provider_dispatch_leases(
  p_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages message
  set delivery_status = 'ambiguous',
      delivery_error = 'ambiguous'
  from private.ebay_provider_dispatch_leases lease
  where lease.user_id = p_user_id
    and lease.expires_at <= statement_timestamp()
    and message.user_id = lease.user_id
    and message.id = lease.message_id
    and message.ebay_account_generation = lease.account_generation
    and message.delivery_status = 'sending'
    and message.delivery_attempted_at = lease.attempted_at;

  delete from private.ebay_provider_dispatch_leases lease
  where lease.user_id = p_user_id
    and lease.expires_at <= statement_timestamp();
end;
$$;

revoke all on function private.expire_ebay_provider_dispatch_leases(text)
  from public, anon, authenticated, service_role;

create table if not exists private.ebay_unmappable_connection_quarantines (
  user_id text primary key,
  quarantined_at timestamptz not null default statement_timestamp(),
  reason text not null default 'missing_verified_seller_identity'
);

revoke all on table private.ebay_unmappable_connection_quarantines
  from public, anon, authenticated, service_role;

create or replace function private.quarantine_unmappable_ebay_connections()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_ids text[];
  v_user_id text;
  v_count integer;
begin
  select coalesce(array_agg(connection.user_id order by connection.user_id), '{}'::text[])
  into v_user_ids
  from public.ebay_connections connection
  where nullif(btrim(connection.ebay_user_id), '') is null
    and nullif(btrim(connection.ebay_username), '') is null;

  v_count := cardinality(v_user_ids);
  if v_count = 0 then
    return 0;
  end if;

  foreach v_user_id in array v_user_ids loop
    perform private.lock_ebay_messaging_account(v_user_id);
  end loop;

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and message.user_id = any(v_user_ids)
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.notifications notification
  using ebay_message_tree message
  where notification.user_id = message.user_id
    and notification.source_message_id = message.id;

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and message.user_id = any(v_user_ids)
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.messages message
  using ebay_message_tree erased
  where message.id = erased.id
    and message.user_id = erased.user_id;

  delete from public.ebay_unresolved_questions pending
  where pending.user_id = any(v_user_ids);

  delete from public.ebay_message_sync_state sync_state
  where sync_state.user_id = any(v_user_ids);

  delete from public.ebay_connections connection
  where connection.user_id = any(v_user_ids);

  delete from private.ebay_seller_identity_tenants seller_identity
  where seller_identity.user_id = any(v_user_ids);

  insert into private.ebay_unmappable_connection_quarantines (user_id)
  select user_id from unnest(v_user_ids) quarantined(user_id)
  on conflict (user_id) do update
    set quarantined_at = statement_timestamp(),
        reason = excluded.reason;

  update private.ebay_messaging_account_generations account
  set generation = gen_random_uuid(),
      seller_erased = false,
      updated_at = statement_timestamp()
  where account.user_id = any(v_user_ids);

  insert into private.ebay_seller_account_generations (
    user_id,
    account_generation
  )
  select account.user_id, account.generation
  from private.ebay_messaging_account_generations account
  where account.user_id = any(v_user_ids)
  on conflict (user_id, account_generation) do nothing;

  return v_count;
end;
$$;

revoke all on function private.quarantine_unmappable_ebay_connections()
  from public, anon, authenticated, service_role;

select private.quarantine_unmappable_ebay_connections();

drop policy if exists ebay_connections_insert_own on public.ebay_connections;
drop policy if exists ebay_connections_update_own on public.ebay_connections;

alter table public.ebay_connections
  add column if not exists account_generation uuid;

update public.ebay_connections connection
set account_generation = account.generation
from private.ebay_messaging_account_generations account
where account.user_id = connection.user_id
  and connection.account_generation is null;

alter table public.ebay_connections
  alter column account_generation set not null;

alter table private.ebay_seller_identity_tenants
  add column if not exists account_generation uuid;

update private.ebay_seller_identity_tenants seller_identity
set account_generation = account.generation
from private.ebay_messaging_account_generations account
where account.user_id = seller_identity.user_id
  and seller_identity.account_generation is null;

alter table private.ebay_seller_identity_tenants
  alter column account_generation set not null;

alter table private.ebay_seller_identity_tenants
  drop constraint if exists ebay_seller_identity_tenants_pkey;

alter table private.ebay_seller_identity_tenants
  add constraint ebay_seller_identity_tenants_pkey primary key (
    identity_kind,
    hash_version,
    identity_hash,
    user_id,
    account_generation
  );

alter table public.messages
  add column if not exists ebay_account_generation uuid;

alter table public.ebay_unresolved_questions
  add column if not exists ebay_account_generation uuid;

alter table public.ebay_message_sync_state
  add column if not exists ebay_account_generation uuid;

update public.messages message
set ebay_account_generation = account.generation
from private.ebay_messaging_account_generations account
where account.user_id = message.user_id
  and message.marketplace = 'ebay'
  and message.ebay_account_generation is null;

update public.ebay_unresolved_questions pending
set ebay_account_generation = account.generation
from private.ebay_messaging_account_generations account
where account.user_id = pending.user_id
  and pending.ebay_account_generation is null;

update public.ebay_message_sync_state sync_state
set ebay_account_generation = account.generation
from private.ebay_messaging_account_generations account
where account.user_id = sync_state.user_id
  and sync_state.ebay_account_generation is null;

alter table public.ebay_unresolved_questions
  alter column ebay_account_generation set not null;

alter table public.ebay_message_sync_state
  alter column ebay_account_generation set not null;

alter table public.messages
  drop constraint if exists messages_ebay_account_generation_required;

alter table public.messages
  add constraint messages_ebay_account_generation_required check (
    marketplace <> 'ebay' or ebay_account_generation is not null
  );

create or replace function private.bind_ebay_account_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_context_generation uuid;
  v_parent_generation uuid;
begin
  if tg_table_name = 'messages' then
    if new.marketplace <> 'ebay' then
      return new;
    end if;
    if new.reply_to is not null then
      select parent.ebay_account_generation
      into v_parent_generation
      from public.messages parent
      where parent.id = new.reply_to
        and parent.user_id = new.user_id;
      if v_parent_generation is not null then
        new.ebay_account_generation := coalesce(
          new.ebay_account_generation,
          v_parent_generation
        );
      end if;
    end if;
  end if;

  v_context_generation := nullif(
    current_setting('app.ebay_account_generation', true),
    ''
  )::uuid;

  if tg_op = 'UPDATE'
    and old.ebay_account_generation is distinct from new.ebay_account_generation
    and new.ebay_account_generation is not null
    and coalesce(
      current_setting('app.ebay_generation_rotation', true),
      'false'
    ) <> 'true' then
    raise exception using errcode = '42501', message = 'eBay account generation is immutable';
  end if;

  if new.ebay_account_generation is null then
    if v_context_generation is not null then
      new.ebay_account_generation := v_context_generation;
    else
      v_account := private.lock_ebay_messaging_account(new.user_id);
      new.ebay_account_generation := v_account.generation;
    end if;
  end if;

  if v_context_generation is not null
    and new.ebay_account_generation is distinct from v_context_generation then
    raise exception using errcode = '42501', message = 'eBay account generation mismatch';
  end if;

  return new;
end;
$$;

revoke all on function private.bind_ebay_account_generation()
  from public, anon, authenticated, service_role;

drop trigger if exists messages_bind_ebay_account_generation on public.messages;
create trigger messages_bind_ebay_account_generation
before insert or update on public.messages
for each row execute function private.bind_ebay_account_generation();

drop trigger if exists unresolved_bind_ebay_account_generation
  on public.ebay_unresolved_questions;
create trigger unresolved_bind_ebay_account_generation
before insert or update on public.ebay_unresolved_questions
for each row execute function private.bind_ebay_account_generation();

drop trigger if exists sync_state_bind_ebay_account_generation
  on public.ebay_message_sync_state;
create trigger sync_state_bind_ebay_account_generation
before insert or update on public.ebay_message_sync_state
for each row execute function private.bind_ebay_account_generation();

create or replace function private.save_ebay_connection_for_tenant(
  p_user_id text,
  p_ebay_user_id text,
  p_ebay_username text,
  p_refresh_token_enc text,
  p_access_token_enc text,
  p_access_token_expires_at timestamptz,
  p_scopes text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_connection public.ebay_connections%rowtype;
  v_user_id_hash text;
  v_username_hash text;
  v_existing_user_id_hash text;
  v_existing_username_hash text;
  v_generation uuid;
  v_lock_keys text[];
  v_lock_key text;
  v_same_identity boolean := false;
begin
  if nullif(btrim(p_refresh_token_enc), '') is null then
    raise exception using errcode = '22023', message = 'An encrypted refresh token is required';
  end if;

  v_user_id_hash := private.hash_ebay_identity('user_id', p_ebay_user_id);
  v_username_hash := private.hash_ebay_identity('username', p_ebay_username);
  if v_user_id_hash is null and v_username_hash is null then
    raise exception using errcode = '22023', message = 'An eBay seller identity is required';
  end if;

  select coalesce(array_agg(lock_key order by lock_key), '{}'::text[])
  into v_lock_keys
  from (
    values
      (case when v_user_id_hash is null then null else 'user_id:' || v_user_id_hash end),
      (case when v_username_hash is null then null else 'username:' || v_username_hash end)
  ) locks(lock_key)
  where lock_key is not null;

  foreach v_lock_key in array v_lock_keys loop
    perform pg_advisory_xact_lock(
      hashtextextended('ebay-identity:' || v_lock_key, 0)
    );
  end loop;

  v_account := private.lock_ebay_messaging_account(p_user_id);
  perform private.expire_ebay_provider_dispatch_leases(p_user_id);
  if exists (
    select 1
    from private.ebay_provider_dispatch_leases lease
    where lease.user_id = p_user_id
      and lease.account_generation = v_account.generation
      and lease.expires_at > statement_timestamp()
  ) then
    raise exception using errcode = '40001', message = 'eBay provider dispatch is active';
  end if;
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;

  if exists (
    select 1
    from private.ebay_erased_identity_tombstones tombstone
    where tombstone.hash_version = 1
      and (
        (tombstone.identity_kind = 'user_id'
          and tombstone.identity_hash = v_user_id_hash)
        or (tombstone.identity_kind = 'username'
          and tombstone.identity_hash = v_username_hash)
      )
  ) then
    raise exception using errcode = '42501', message = 'eBay seller identity has been erased';
  end if;

  select connection.*
  into v_connection
  from public.ebay_connections connection
  where connection.user_id = p_user_id
  for update;

  if found then
    v_existing_user_id_hash := private.hash_ebay_identity(
      'user_id',
      v_connection.ebay_user_id
    );
    v_existing_username_hash := private.hash_ebay_identity(
      'username',
      v_connection.ebay_username
    );
    v_same_identity := case
      when v_user_id_hash is not null
        and v_existing_user_id_hash is not null
        then v_user_id_hash = v_existing_user_id_hash
      when v_username_hash is not null
        and v_existing_username_hash is not null
        then v_username_hash = v_existing_username_hash
      else false
    end;
    v_generation := v_connection.account_generation;
  else
    select seller_identity.account_generation
    into v_generation
    from private.ebay_seller_identity_tenants seller_identity
    join private.ebay_seller_account_generations seller_account
      on seller_account.user_id = seller_identity.user_id
      and seller_account.account_generation = seller_identity.account_generation
    where seller_identity.user_id = p_user_id
      and seller_identity.hash_version = 1
      and seller_account.seller_erased = false
      and (
        (v_user_id_hash is not null
          and seller_identity.identity_kind = 'user_id'
          and seller_identity.identity_hash = v_user_id_hash)
        or (v_user_id_hash is null
          and seller_identity.identity_kind = 'username'
          and seller_identity.identity_hash = v_username_hash)
      )
    order by seller_identity.linked_at desc
    limit 1;
    v_same_identity := found;
    if not v_same_identity then
      v_generation := v_account.generation;
      if exists (
        select 1
        from private.ebay_seller_identity_tenants seller_identity
        where seller_identity.user_id = p_user_id
          and seller_identity.account_generation = v_account.generation
      ) then
        v_generation := gen_random_uuid();
      end if;
    end if;
  end if;

  if not v_same_identity and v_connection.user_id is not null then
    v_generation := gen_random_uuid();
  end if;

  if v_generation is distinct from v_account.generation then
    delete from public.ebay_message_sync_state sync_state
    where sync_state.user_id = p_user_id;
    update private.ebay_messaging_account_generations account
    set generation = v_generation,
        seller_erased = false,
        updated_at = statement_timestamp()
    where account.user_id = p_user_id;
  end if;

  insert into private.ebay_seller_account_generations (
    user_id,
    account_generation
  ) values (
    p_user_id,
    v_generation
  )
  on conflict (user_id, account_generation) do nothing;

  insert into public.ebay_connections (
    user_id,
    ebay_user_id,
    ebay_username,
    refresh_token_enc,
    access_token_enc,
    access_token_expires_at,
    scopes,
    account_generation
  ) values (
    p_user_id,
    nullif(btrim(p_ebay_user_id), ''),
    nullif(btrim(p_ebay_username), ''),
    p_refresh_token_enc,
    p_access_token_enc,
    p_access_token_expires_at,
    coalesce(p_scopes, '{}'::text[]),
    v_generation
  )
  on conflict (user_id) do update
  set ebay_user_id = excluded.ebay_user_id,
      ebay_username = excluded.ebay_username,
      refresh_token_enc = excluded.refresh_token_enc,
      access_token_enc = excluded.access_token_enc,
      access_token_expires_at = excluded.access_token_expires_at,
      scopes = excluded.scopes,
      account_generation = excluded.account_generation;

  insert into private.ebay_seller_identity_tenants (
    identity_kind,
    hash_version,
    identity_hash,
    user_id,
    account_generation
  )
  select identity_kind, 1, identity_hash, p_user_id, v_generation
  from (
    values
      ('user_id'::text, v_user_id_hash),
      ('username'::text, v_username_hash)
  ) identity(identity_kind, identity_hash)
  where identity_hash is not null
  on conflict (
    identity_kind,
    hash_version,
    identity_hash,
    user_id,
    account_generation
  ) do nothing;

  delete from private.ebay_unmappable_connection_quarantines quarantine
  where quarantine.user_id = p_user_id;
end;
$$;

revoke all on function private.save_ebay_connection_for_tenant(
  text, text, text, text, text, timestamptz, text[]
) from public, anon, authenticated, service_role;

drop function if exists public.update_ebay_access_token_cache(text, timestamptz);
drop function if exists public.update_scheduled_ebay_access_token_cache(
  text, text, timestamptz
);
drop function if exists private.update_ebay_access_token_cache_for_tenant(
  text, text, timestamptz
);

create function private.update_ebay_access_token_cache_for_tenant(
  p_user_id text,
  p_account_generation uuid,
  p_access_token_enc text,
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  if nullif(btrim(p_access_token_enc), '') is null then
    raise exception using errcode = '22023', message = 'An encrypted access token is required';
  end if;
  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.generation is distinct from p_account_generation then
    raise exception using errcode = '40001', message = 'eBay connection generation expired';
  end if;
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;
  update public.ebay_connections connection
  set access_token_enc = p_access_token_enc,
      access_token_expires_at = p_access_token_expires_at
  where connection.user_id = p_user_id
    and connection.account_generation = v_account.generation;
  if not found then
    raise exception using errcode = 'P0002', message = 'eBay connection not found';
  end if;
end;
$$;

revoke all on function private.update_ebay_access_token_cache_for_tenant(
  text, uuid, text, timestamptz
) from public, anon, authenticated, service_role;

create function public.update_ebay_access_token_cache(
  p_account_generation uuid,
  p_access_token_enc text,
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  perform private.update_ebay_access_token_cache_for_tenant(
    v_user_id,
    p_account_generation,
    p_access_token_enc,
    p_access_token_expires_at
  );
end;
$$;

revoke all on function public.update_ebay_access_token_cache(uuid, text, timestamptz)
  from public, anon, service_role;
grant execute on function public.update_ebay_access_token_cache(uuid, text, timestamptz)
  to authenticated;

create function public.update_scheduled_ebay_access_token_cache(
  p_user_id text,
  p_account_generation uuid,
  p_access_token_enc text,
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  perform private.update_ebay_access_token_cache_for_tenant(
    p_user_id,
    p_account_generation,
    p_access_token_enc,
    p_access_token_expires_at
  );
end;
$$;

revoke all on function public.update_scheduled_ebay_access_token_cache(
  text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.update_scheduled_ebay_access_token_cache(
  text, uuid, text, timestamptz
) to service_role;

create or replace function private.apply_serialized_ebay_message_write_for_tenant(
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
  v_account private.ebay_messaging_account_generations%rowtype;
  v_buyer_hash text;
  v_result jsonb;
  v_count integer;
  v_attempted_at timestamptz;
begin
  if p_operation in ('upsert_unresolved_question', 'import_question') then
    v_buyer_hash := private.hash_ebay_identity(
      'sender_id',
      p_payload->>'external_buyer_id'
    );
    if v_buyer_hash is not null then
      perform pg_advisory_xact_lock(
        hashtextextended('ebay-identity:sender_id:' || v_buyer_hash, 0)
      );
    end if;
  end if;

  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.generation is distinct from p_generation then
    raise exception using
      errcode = '40001',
      message = 'eBay messaging account generation expired';
  end if;
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;
  if v_buyer_hash is not null and exists (
    select 1
    from private.ebay_erased_identity_tombstones tombstone
    where tombstone.identity_kind = 'sender_id'
      and tombstone.hash_version = 1
      and tombstone.identity_hash = v_buyer_hash
  ) then
    raise exception using errcode = '42501', message = 'eBay identity has been erased';
  end if;

  if p_operation = 'begin_provider_dispatch' then
    v_attempted_at := (p_payload->>'attempted_at')::timestamptz;
    perform private.expire_ebay_provider_dispatch_leases(p_user_id);
    perform 1
    from public.messages message
    where message.user_id = p_user_id
      and message.id = (p_payload->>'message_id')::uuid
      and message.marketplace = 'ebay'
      and message.ebay_account_generation = p_generation
      and message.delivery_status = 'sending'
      and message.delivery_attempted_at = v_attempted_at;
    if not found then
      raise exception using errcode = 'P0002', message = 'Provider dispatch claim was lost';
    end if;

    insert into private.ebay_provider_dispatch_leases (
      user_id,
      message_id,
      account_generation,
      attempted_at,
      expires_at
    ) values (
      p_user_id,
      (p_payload->>'message_id')::uuid,
      p_generation,
      v_attempted_at,
      greatest(v_attempted_at, statement_timestamp()) + interval '5 minutes'
    )
    on conflict (user_id, message_id) do nothing;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception using errcode = '40001', message = 'Provider dispatch is already active';
    end if;
    return jsonb_build_object('account_generation', p_generation);
  end if;

  perform set_config(
    'app.ebay_account_generation',
    p_generation::text,
    true
  );
  begin
    v_result := private.apply_ebay_message_write_for_tenant(
      p_user_id,
      p_operation,
      p_payload
    );
  exception when others then
    perform set_config('app.ebay_account_generation', '', true);
    raise;
  end;
  perform set_config('app.ebay_account_generation', '', true);
  if p_operation in (
    'fail_canonical',
    'complete_canonical',
    'fail_followup',
    'complete_followup'
  ) then
    delete from private.ebay_provider_dispatch_leases lease
    where lease.user_id = p_user_id
      and lease.message_id = (p_payload->>'message_id')::uuid
      and lease.account_generation = p_generation
      and lease.attempted_at = (p_payload->>'attempted_at')::timestamptz;
  end if;
  return v_result;
end;
$$;

revoke all on function private.apply_serialized_ebay_message_write_for_tenant(
  text, text, jsonb, uuid
) from public, anon, authenticated, service_role;

create or replace function public.list_scheduled_ebay_connection_user_ids()
returns table (user_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  return query
    select connection.user_id
    from public.ebay_connections connection
    join private.ebay_messaging_account_generations account
      on account.user_id = connection.user_id
      and account.generation = connection.account_generation
    where account.seller_erased = false
    order by connection.user_id
    limit 50;
end;
$$;

revoke all on function public.list_scheduled_ebay_connection_user_ids()
  from public, anon, authenticated;
grant execute on function public.list_scheduled_ebay_connection_user_ids()
  to service_role;

create or replace function public.read_scheduled_ebay_connection(p_user_id text)
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
  select to_jsonb(connection)
  into v_result
  from public.ebay_connections connection
  join private.ebay_messaging_account_generations account
    on account.user_id = connection.user_id
    and account.generation = connection.account_generation
  where connection.user_id = p_user_id
    and account.seller_erased = false;
  return v_result;
end;
$$;

revoke all on function public.read_scheduled_ebay_connection(text)
  from public, anon, authenticated;
grant execute on function public.read_scheduled_ebay_connection(text)
  to service_role;

create or replace function public.read_scheduled_ebay_inbox(
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
  select account.*
  into v_account
  from private.ebay_messaging_account_generations account
  where account.user_id = p_user_id;
  if not found or v_account.seller_erased then
    raise exception using errcode = '42501', message = 'Seller messaging account is unavailable';
  end if;

  if p_operation = 'cursor' then
    select jsonb_build_object('cursor_at', sync_state.cursor_at)
    into v_result
    from public.ebay_message_sync_state sync_state
    where sync_state.user_id = p_user_id
      and sync_state.ebay_account_generation = v_account.generation;
    return v_result;
  elsif p_operation = 'pending_questions' then
    select coalesce(jsonb_agg(to_jsonb(pending) order by
      pending.last_resolution_attempted_at,
      pending.external_created_at
    ), '[]'::jsonb)
    into v_result
    from (
      select unresolved.external_message_id,
             unresolved.external_parent_id,
             unresolved.external_listing_id,
             unresolved.external_buyer_id,
             unresolved.body,
             unresolved.subject,
             unresolved.external_created_at,
             unresolved.resolution_window_from,
             unresolved.observed_cursor_at,
             unresolved.last_resolution_attempted_at
      from public.ebay_unresolved_questions unresolved
      where unresolved.user_id = p_user_id
        and unresolved.ebay_account_generation = v_account.generation
        and unresolved.resolution_status = 'pending'
      order by unresolved.last_resolution_attempted_at,
               unresolved.external_created_at
      limit 50
    ) pending;
    return v_result;
  elsif p_operation = 'pending_count' then
    select to_jsonb(count(*)::integer)
    into v_result
    from public.ebay_unresolved_questions pending
    where pending.user_id = p_user_id
      and pending.ebay_account_generation = v_account.generation
      and pending.resolution_status = 'pending';
    return v_result;
  elsif p_operation = 'actionable_questions' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'externalMessageId', message.external_message_id,
      'createdAt', message.external_created_at
    )), '[]'::jsonb)
    into v_result
    from public.messages message
    where message.user_id = p_user_id
      and message.ebay_account_generation = v_account.generation
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and message.status in ('new', 'drafting', 'drafted', 'draft_failed', 'sent')
      and message.external_message_id is not null
      and message.external_created_at is not null
      and not exists (
        select 1
        from public.messages reply
        where reply.user_id = p_user_id
          and reply.ebay_account_generation = v_account.generation
          and reply.reply_to = message.id
          and reply.marketplace = 'ebay'
          and reply.direction = 'outbound'
          and reply.delivery_status = 'delivered'
          and reply.external_delivery_id is not null
          and (reply.reply_kind is null or reply.reply_kind = 'reply')
      );
    return v_result;
  elsif p_operation = 'active_listing' then
    select jsonb_build_object(
      'item_id', item.id,
      'listing_id', listing.id,
      'title', listing.title,
      'description', listing.description,
      'attributes', item.attributes,
      'condition', item.condition
    )
    into v_result
    from public.listings listing
    join public.items item
      on item.id = listing.item_id
      and item.user_id = listing.user_id
    where listing.user_id = p_user_id
      and listing.platform = 'ebay'
      and listing.ebay_listing_id = p_payload->>'external_listing_id'
      and listing.ebay_status = 'published'
      and listing.status = 'published';
    return v_result;
  elsif p_operation = 'draft_candidates' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'message', to_jsonb(candidate),
      'attributes', item.attributes,
      'condition', item.condition,
      'listing_title', listing.title,
      'listing_description', listing.description
    ) order by candidate.created_at), '[]'::jsonb)
    into v_result
    from (
      select message.*
      from public.messages message
      where message.user_id = p_user_id
        and message.ebay_account_generation = v_account.generation
        and message.marketplace = 'ebay'
        and message.direction = 'inbound'
        and (
          message.status in ('new', 'draft_failed')
          or (
            message.status = 'drafting'
            and message.updated_at < (p_payload->>'stale_before')::timestamptz
          )
        )
      order by message.created_at
      limit 50
    ) candidate
    join public.items item
      on item.id = candidate.item_id
      and item.user_id = p_user_id
    join public.listings listing
      on listing.id = candidate.listing_id
      and listing.item_id = item.id
      and listing.user_id = p_user_id;
    return v_result;
  end if;

  raise exception using errcode = '22023', message = 'Unsupported scheduled inbox read';
end;
$$;

revoke all on function public.read_scheduled_ebay_inbox(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.read_scheduled_ebay_inbox(text, text, jsonb)
  to service_role;

create or replace function public.erase_ebay_user_data(
  p_ebay_user_id text default null,
  p_ebay_username text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id_hash text;
  v_username_hash text;
  v_buyer_hashes text[];
  v_lock_keys text[];
  v_seller_accounts jsonb;
  v_seller_user_ids text[];
  v_buyer_user_ids text[];
  v_user_ids text[];
  v_lock_key text;
  v_user_id text;
  v_account private.ebay_messaging_account_generations%rowtype;
  v_old_generation uuid;
  v_new_generation uuid;
  v_current_seller_erased boolean;
  v_erased integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Account deletion authorization is required';
  end if;

  v_user_id_hash := private.hash_ebay_identity('user_id', p_ebay_user_id);
  v_username_hash := private.hash_ebay_identity('username', p_ebay_username);

  select coalesce(array_agg(distinct identity_hash), '{}'::text[])
  into v_buyer_hashes
  from unnest(array[
    private.hash_ebay_identity('sender_id', p_ebay_user_id),
    private.hash_ebay_identity('sender_id', p_ebay_username)
  ]) identity(identity_hash)
  where identity_hash is not null;

  select coalesce(array_agg(distinct lock_key), '{}'::text[])
  into v_lock_keys
  from (
    values
      (case when v_user_id_hash is null then null else 'user_id:' || v_user_id_hash end),
      (case when v_username_hash is null then null else 'username:' || v_username_hash end)
    union all
    select 'sender_id:' || identity_hash
    from unnest(v_buyer_hashes) buyer(identity_hash)
  ) locks(lock_key)
  where lock_key is not null;

  if cardinality(v_lock_keys) = 0 then
    return 0;
  end if;

  foreach v_lock_key in array (
    select array_agg(lock_key order by lock_key)
    from unnest(v_lock_keys) lock(lock_key)
  ) loop
    perform pg_advisory_xact_lock(
      hashtextextended('ebay-identity:' || v_lock_key, 0)
    );
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', matched.user_id,
    'account_generation', matched.account_generation
  )), '[]'::jsonb)
  into v_seller_accounts
  from (
    select distinct seller_identity.user_id,
           seller_identity.account_generation
    from private.ebay_seller_identity_tenants seller_identity
    join private.ebay_seller_account_generations seller_account
      on seller_account.user_id = seller_identity.user_id
      and seller_account.account_generation = seller_identity.account_generation
    where seller_identity.hash_version = 1
      and seller_account.seller_erased = false
      and (
        (v_user_id_hash is not null
          and seller_identity.identity_kind = 'user_id'
          and seller_identity.identity_hash = v_user_id_hash)
        or (v_username_hash is not null
          and seller_identity.identity_kind = 'username'
          and seller_identity.identity_hash = v_username_hash
          and not exists (
            select 1
            from private.ebay_seller_identity_tenants stable_identity
            where stable_identity.user_id = seller_identity.user_id
              and stable_identity.account_generation = seller_identity.account_generation
              and stable_identity.hash_version = 1
              and stable_identity.identity_kind = 'user_id'
              and stable_identity.identity_hash is distinct from v_user_id_hash
          ))
      )
  ) matched;

  select coalesce(array_agg(distinct matched.user_id), '{}'::text[])
  into v_seller_user_ids
  from jsonb_to_recordset(v_seller_accounts) as matched(
    user_id text,
    account_generation uuid
  );

  select coalesce(array_agg(distinct matched.user_id), '{}'::text[])
  into v_buyer_user_ids
  from (
    select message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and private.hash_ebay_identity(
        'sender_id',
        message.external_buyer_id
      ) = any(v_buyer_hashes)
    union
    select pending.user_id
    from public.ebay_unresolved_questions pending
    where private.hash_ebay_identity(
      'sender_id',
      pending.external_buyer_id
    ) = any(v_buyer_hashes)
  ) matched;

  select coalesce(array_agg(distinct user_id), '{}'::text[])
  into v_user_ids
  from unnest(v_seller_user_ids || v_buyer_user_ids) matched(user_id);

  v_erased := cardinality(v_user_ids);

  foreach v_user_id in array (
    select coalesce(array_agg(user_id order by user_id), '{}'::text[])
    from unnest(v_user_ids) matched(user_id)
  ) loop
    perform private.lock_ebay_messaging_account(v_user_id);
    perform private.expire_ebay_provider_dispatch_leases(v_user_id);
    if exists (
      select 1
      from private.ebay_provider_dispatch_leases lease
      where lease.user_id = v_user_id
        and lease.expires_at > statement_timestamp()
    ) then
      raise exception using errcode = '40001', message = 'eBay provider dispatch is active';
    end if;
  end loop;

  insert into private.ebay_erased_identity_tombstones (
    identity_kind,
    hash_version,
    identity_hash,
    erased_at
  )
  select identity_kind, 1, identity_hash, statement_timestamp()
  from (
    values
      ('user_id'::text, v_user_id_hash),
      ('username'::text, case
        when v_user_id_hash is null then v_username_hash
        else null
      end)
    union all
    select 'sender_id'::text, identity_hash
    from unnest(v_buyer_hashes) buyer(identity_hash)
  ) identity(identity_kind, identity_hash)
  where identity_hash is not null
  on conflict (identity_kind, hash_version, identity_hash) do update
    set erased_at = greatest(
      private.ebay_erased_identity_tombstones.erased_at,
      excluded.erased_at
    );

  update private.ebay_seller_account_generations seller_account
  set seller_erased = true,
      erased_at = statement_timestamp()
  where exists (
    select 1
    from jsonb_to_recordset(v_seller_accounts) as matched(
      user_id text,
      account_generation uuid
    )
    where matched.user_id = seller_account.user_id
      and matched.account_generation = seller_account.account_generation
  );

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and (
        exists (
          select 1
          from jsonb_to_recordset(v_seller_accounts) as matched(
            user_id text,
            account_generation uuid
          )
          where matched.user_id = message.user_id
            and matched.account_generation = message.ebay_account_generation
        )
        or (
          message.user_id = any(v_buyer_user_ids)
          and private.hash_ebay_identity(
            'sender_id',
            message.external_buyer_id
          ) = any(v_buyer_hashes)
        )
      )
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.notifications notification
  using ebay_message_tree message
  where notification.user_id = message.user_id
    and notification.source_message_id = message.id;

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and (
        exists (
          select 1
          from jsonb_to_recordset(v_seller_accounts) as matched(
            user_id text,
            account_generation uuid
          )
          where matched.user_id = message.user_id
            and matched.account_generation = message.ebay_account_generation
        )
        or (
          message.user_id = any(v_buyer_user_ids)
          and private.hash_ebay_identity(
            'sender_id',
            message.external_buyer_id
          ) = any(v_buyer_hashes)
        )
      )
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.messages message
  using ebay_message_tree erased
  where message.id = erased.id
    and message.user_id = erased.user_id;

  delete from public.ebay_unresolved_questions pending
  where exists (
      select 1
      from jsonb_to_recordset(v_seller_accounts) as matched(
        user_id text,
        account_generation uuid
      )
      where matched.user_id = pending.user_id
        and matched.account_generation = pending.ebay_account_generation
    )
    or (
      pending.user_id = any(v_buyer_user_ids)
      and private.hash_ebay_identity(
        'sender_id',
        pending.external_buyer_id
      ) = any(v_buyer_hashes)
    );

  delete from public.ebay_message_sync_state sync_state
  where sync_state.user_id = any(v_buyer_user_ids)
    or exists (
      select 1
      from jsonb_to_recordset(v_seller_accounts) as matched(
        user_id text,
        account_generation uuid
      )
      where matched.user_id = sync_state.user_id
        and matched.account_generation = sync_state.ebay_account_generation
    );

  delete from public.ebay_connections connection
  where exists (
    select 1
    from jsonb_to_recordset(v_seller_accounts) as matched(
      user_id text,
      account_generation uuid
    )
    where matched.user_id = connection.user_id
      and matched.account_generation = connection.account_generation
  );

  delete from private.ebay_seller_identity_tenants seller_identity
  where exists (
    select 1
    from jsonb_to_recordset(v_seller_accounts) as matched(
      user_id text,
      account_generation uuid
    )
    where matched.user_id = seller_identity.user_id
      and matched.account_generation = seller_identity.account_generation
  );

  foreach v_user_id in array v_seller_user_ids loop
    v_account := private.lock_ebay_messaging_account(v_user_id);
    select exists (
      select 1
      from jsonb_to_recordset(v_seller_accounts) as matched(
        user_id text,
        account_generation uuid
      )
      where matched.user_id = v_user_id
        and matched.account_generation = v_account.generation
    )
    into v_current_seller_erased;
    if v_current_seller_erased then
      v_new_generation := gen_random_uuid();
      update private.ebay_messaging_account_generations account
      set generation = v_new_generation,
          seller_erased = true,
          updated_at = statement_timestamp()
      where account.user_id = v_user_id;
      insert into private.ebay_seller_account_generations (
        user_id,
        account_generation,
        seller_erased,
        erased_at
      ) values (
        v_user_id,
        v_new_generation,
        true,
        statement_timestamp()
      )
      on conflict (user_id, account_generation) do update
        set seller_erased = true,
            erased_at = excluded.erased_at;
    end if;
  end loop;

  foreach v_user_id in array v_buyer_user_ids loop
    v_account := private.lock_ebay_messaging_account(v_user_id);
    select exists (
      select 1
      from jsonb_to_recordset(v_seller_accounts) as matched(
        user_id text,
        account_generation uuid
      )
      where matched.user_id = v_user_id
        and matched.account_generation = v_account.generation
    )
    into v_current_seller_erased;
    if not v_current_seller_erased and not v_account.seller_erased then
      v_old_generation := v_account.generation;
      v_new_generation := gen_random_uuid();
      perform set_config('app.ebay_generation_rotation', 'true', true);
      update private.ebay_messaging_account_generations account
      set generation = v_new_generation,
          updated_at = statement_timestamp()
      where account.user_id = v_user_id;
      update public.ebay_connections connection
      set account_generation = v_new_generation
      where connection.user_id = v_user_id
        and connection.account_generation = v_old_generation;
      update public.messages message
      set ebay_account_generation = v_new_generation
      where message.user_id = v_user_id
        and message.marketplace = 'ebay'
        and message.ebay_account_generation = v_old_generation;
      update public.ebay_unresolved_questions pending
      set ebay_account_generation = v_new_generation
      where pending.user_id = v_user_id
        and pending.ebay_account_generation = v_old_generation;
      insert into private.ebay_seller_account_generations (
        user_id,
        account_generation
      ) values (
        v_user_id,
        v_new_generation
      )
      on conflict (user_id, account_generation) do nothing;
      insert into private.ebay_seller_identity_tenants (
        identity_kind,
        hash_version,
        identity_hash,
        user_id,
        linked_at,
        account_generation
      )
      select seller_identity.identity_kind,
             seller_identity.hash_version,
             seller_identity.identity_hash,
             seller_identity.user_id,
             seller_identity.linked_at,
             v_new_generation
      from private.ebay_seller_identity_tenants seller_identity
      where seller_identity.user_id = v_user_id
        and seller_identity.account_generation = v_old_generation
      on conflict (
        identity_kind,
        hash_version,
        identity_hash,
        user_id,
        account_generation
      ) do nothing;
      delete from private.ebay_seller_identity_tenants seller_identity
      where seller_identity.user_id = v_user_id
        and seller_identity.account_generation = v_old_generation;
      delete from private.ebay_seller_account_generations seller_account
      where seller_account.user_id = v_user_id
        and seller_account.account_generation = v_old_generation;
      perform set_config('app.ebay_generation_rotation', 'false', true);
    end if;
  end loop;

  return v_erased;
end;
$$;

revoke all on function public.erase_ebay_user_data(text, text)
  from public, anon, authenticated;
grant execute on function public.erase_ebay_user_data(text, text)
  to service_role;
