create extension if not exists pgcrypto with schema extensions;

create table if not exists private.ebay_identity_hash_keys (
  hash_version smallint primary key check (hash_version > 0),
  secret bytea not null check (octet_length(secret) >= 32),
  created_at timestamptz not null default statement_timestamp()
);

insert into private.ebay_identity_hash_keys (hash_version, secret)
values (1, extensions.gen_random_bytes(32))
on conflict (hash_version) do nothing;

create table if not exists private.ebay_erased_identity_tombstones (
  identity_kind text not null check (
    identity_kind in ('user_id', 'username', 'sender_id')
  ),
  hash_version smallint not null default 1
    references private.ebay_identity_hash_keys (hash_version),
  identity_hash text not null check (length(identity_hash) = 64),
  erased_at timestamptz not null default statement_timestamp(),
  primary key (identity_kind, hash_version, identity_hash)
);

create table if not exists private.ebay_messaging_account_generations (
  user_id text primary key,
  generation uuid not null default gen_random_uuid(),
  seller_erased boolean not null default false,
  updated_at timestamptz not null default statement_timestamp()
);

revoke all on table private.ebay_identity_hash_keys
  from public, anon, authenticated, service_role;
revoke all on table private.ebay_erased_identity_tombstones
  from public, anon, authenticated, service_role;
revoke all on table private.ebay_messaging_account_generations
  from public, anon, authenticated, service_role;

create or replace function private.hash_ebay_identity(
  p_identity_kind text,
  p_identity text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when nullif(btrim(p_identity), '') is null then null
    else encode(
      extensions.hmac(
        convert_to(
          p_identity_kind || ':' || case
            when p_identity_kind = 'username' then lower(btrim(p_identity))
            else btrim(p_identity)
          end,
          'UTF8'
        ),
        key.secret,
        'sha256'
      ),
      'hex'
    )
  end
  from private.ebay_identity_hash_keys key
  where key.hash_version = 1
$$;

revoke all on function private.hash_ebay_identity(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.lock_ebay_messaging_account(p_user_id text)
returns private.ebay_messaging_account_generations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  if nullif(btrim(p_user_id), '') is null then
    raise exception using errcode = '22023', message = 'A seller tenant is required';
  end if;

  insert into private.ebay_messaging_account_generations (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select account.*
  into v_account
  from private.ebay_messaging_account_generations account
  where account.user_id = p_user_id
  for update;

  return v_account;
end;
$$;

revoke all on function private.lock_ebay_messaging_account(text)
  from public, anon, authenticated, service_role;

create or replace function private.begin_ebay_message_write_for_tenant(
  p_user_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;
  return v_account.generation;
end;
$$;

revoke all on function private.begin_ebay_message_write_for_tenant(text)
  from public, anon, authenticated, service_role;

create or replace function public.begin_ebay_message_write()
returns uuid
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
  return private.begin_ebay_message_write_for_tenant(v_user_id);
end;
$$;

revoke all on function public.begin_ebay_message_write()
  from public, anon, service_role;
grant execute on function public.begin_ebay_message_write()
  to authenticated;

create or replace function public.begin_scheduled_ebay_message_write(
  p_user_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  return private.begin_ebay_message_write_for_tenant(p_user_id);
end;
$$;

revoke all on function public.begin_scheduled_ebay_message_write(text)
  from public, anon, authenticated;
grant execute on function public.begin_scheduled_ebay_message_write(text)
  to service_role;

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

  return private.apply_ebay_message_write_for_tenant(
    p_user_id,
    p_operation,
    p_payload
  );
end;
$$;

revoke all on function private.apply_serialized_ebay_message_write_for_tenant(
  text, text, jsonb, uuid
) from public, anon, authenticated, service_role;

drop function public.apply_ebay_message_write(text, jsonb);
drop function public.apply_scheduled_ebay_message_write(text, text, jsonb);
drop function private.apply_authenticated_ebay_message_write(text, jsonb);
drop function private.apply_scheduled_ebay_message_write(text, text, jsonb);

create or replace function private.apply_authenticated_ebay_message_write(
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
  return private.apply_serialized_ebay_message_write_for_tenant(
    v_user_id,
    p_operation,
    p_payload,
    p_generation
  );
end;
$$;

revoke all on function private.apply_authenticated_ebay_message_write(
  text, jsonb, uuid
) from public, anon, service_role;
grant execute on function private.apply_authenticated_ebay_message_write(
  text, jsonb, uuid
) to authenticated;

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
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  if p_operation not in (
    'sync_mark_attempt',
    'sync_mark_success',
    'sync_mark_failure',
    'upsert_unresolved_question',
    'mark_unresolved_question_failed',
    'remove_unresolved_question',
    'retire_unresolved_question',
    'mark_externally_answered',
    'mark_provider_unavailable',
    'import_question',
    'ensure_notification',
    'claim_draft',
    'attach_draft',
    'mark_draft_failed'
  ) then
    raise exception using errcode = '42501', message = 'Scheduler operation is not allowed';
  end if;
  return private.apply_serialized_ebay_message_write_for_tenant(
    p_user_id,
    p_operation,
    p_payload,
    p_generation
  );
end;
$$;

revoke all on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) to service_role;

create or replace function public.apply_ebay_message_write(
  p_operation text,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.apply_authenticated_ebay_message_write(
    p_operation,
    p_payload,
    p_generation
  )
$$;

revoke all on function public.apply_ebay_message_write(text, jsonb, uuid)
  from public, anon, service_role;
grant execute on function public.apply_ebay_message_write(text, jsonb, uuid)
  to authenticated;

create or replace function public.apply_scheduled_ebay_message_write(
  p_user_id text,
  p_operation text,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.apply_scheduled_ebay_message_write(
    p_user_id,
    p_operation,
    p_payload,
    p_generation
  )
$$;

revoke all on function public.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) to service_role;

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
  v_seller_user_ids text[];
  v_buyer_user_ids text[];
  v_user_ids text[];
  v_lock_key text;
  v_user_id text;
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

  select coalesce(array_agg(distinct connection.user_id), '{}'::text[])
  into v_seller_user_ids
  from public.ebay_connections connection
  where (
      v_user_id_hash is not null
      and private.hash_ebay_identity('user_id', connection.ebay_user_id) = v_user_id_hash
    ) or (
      v_username_hash is not null
      and private.hash_ebay_identity('username', connection.ebay_username) = v_username_hash
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

  if v_erased > 0 then
    foreach v_user_id in array (
      select array_agg(user_id order by user_id)
      from unnest(v_user_ids) matched(user_id)
    ) loop
      perform private.lock_ebay_messaging_account(v_user_id);
    end loop;
  end if;

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
      ('username'::text, v_username_hash)
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

  update private.ebay_messaging_account_generations account
  set generation = gen_random_uuid(),
      seller_erased = account.seller_erased
        or account.user_id = any(v_seller_user_ids),
      updated_at = statement_timestamp()
  where account.user_id = any(v_user_ids);

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.marketplace = 'ebay'
      and (
        message.user_id = any(v_seller_user_ids)
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
        message.user_id = any(v_seller_user_ids)
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
  where pending.user_id = any(v_seller_user_ids)
     or (
       pending.user_id = any(v_buyer_user_ids)
       and private.hash_ebay_identity(
         'sender_id',
         pending.external_buyer_id
       ) = any(v_buyer_hashes)
     );

  delete from public.ebay_message_sync_state sync_state
  where sync_state.user_id = any(v_user_ids);

  delete from public.ebay_connections connection
  where connection.user_id = any(v_seller_user_ids);

  return v_erased;
end;
$$;

revoke all on function public.erase_ebay_user_data(text, text)
  from public, anon, authenticated;
grant execute on function public.erase_ebay_user_data(text, text)
  to service_role;
