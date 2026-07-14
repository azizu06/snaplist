create table if not exists private.ebay_seller_identity_tenants (
  identity_kind text not null check (identity_kind in ('user_id', 'username')),
  hash_version smallint not null default 1
    references private.ebay_identity_hash_keys (hash_version),
  identity_hash text not null check (length(identity_hash) = 64),
  user_id text not null,
  linked_at timestamptz not null default statement_timestamp(),
  primary key (identity_kind, hash_version, identity_hash, user_id)
);

revoke all on table private.ebay_seller_identity_tenants
  from public, anon, authenticated, service_role;

insert into private.ebay_seller_identity_tenants (
  identity_kind,
  hash_version,
  identity_hash,
  user_id
)
select identity.identity_kind,
       1,
       private.hash_ebay_identity(identity.identity_kind, identity.identity_value),
       connection.user_id
from public.ebay_connections connection
cross join lateral (
  values
    ('user_id'::text, connection.ebay_user_id),
    ('username'::text, connection.ebay_username)
) identity(identity_kind, identity_value)
where private.hash_ebay_identity(
  identity.identity_kind,
  identity.identity_value
) is not null
on conflict (identity_kind, hash_version, identity_hash, user_id) do nothing;

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
  v_user_id_hash text;
  v_username_hash text;
  v_lock_keys text[];
  v_lock_key text;
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

  insert into public.ebay_connections (
    user_id,
    ebay_user_id,
    ebay_username,
    refresh_token_enc,
    access_token_enc,
    access_token_expires_at,
    scopes
  ) values (
    p_user_id,
    nullif(btrim(p_ebay_user_id), ''),
    nullif(btrim(p_ebay_username), ''),
    p_refresh_token_enc,
    p_access_token_enc,
    p_access_token_expires_at,
    coalesce(p_scopes, '{}'::text[])
  )
  on conflict (user_id) do update
  set ebay_user_id = excluded.ebay_user_id,
      ebay_username = excluded.ebay_username,
      refresh_token_enc = excluded.refresh_token_enc,
      access_token_enc = excluded.access_token_enc,
      access_token_expires_at = excluded.access_token_expires_at,
      scopes = excluded.scopes;

  insert into private.ebay_seller_identity_tenants (
    identity_kind,
    hash_version,
    identity_hash,
    user_id
  )
  select identity_kind, 1, identity_hash, p_user_id
  from (
    values
      ('user_id'::text, v_user_id_hash),
      ('username'::text, v_username_hash)
  ) identity(identity_kind, identity_hash)
  where identity_hash is not null
  on conflict (identity_kind, hash_version, identity_hash, user_id) do nothing;
end;
$$;

revoke all on function private.save_ebay_connection_for_tenant(
  text, text, text, text, text, timestamptz, text[]
) from public, anon, authenticated, service_role;

create or replace function public.save_ebay_connection(
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

  perform private.save_ebay_connection_for_tenant(
    v_user_id,
    p_ebay_user_id,
    p_ebay_username,
    p_refresh_token_enc,
    p_access_token_enc,
    p_access_token_expires_at,
    p_scopes
  );
end;
$$;

revoke all on function public.save_ebay_connection(
  text, text, text, text, timestamptz, text[]
) from public, anon, service_role;
grant execute on function public.save_ebay_connection(
  text, text, text, text, timestamptz, text[]
) to authenticated;

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

  select coalesce(array_agg(distinct matched.user_id), '{}'::text[])
  into v_seller_user_ids
  from (
    select connection.user_id
    from public.ebay_connections connection
    where (
        v_user_id_hash is not null
        and private.hash_ebay_identity('user_id', connection.ebay_user_id) = v_user_id_hash
      ) or (
        v_username_hash is not null
        and private.hash_ebay_identity('username', connection.ebay_username) = v_username_hash
      )
    union
    select seller_identity.user_id
    from private.ebay_seller_identity_tenants seller_identity
    where seller_identity.hash_version = 1
      and (
        (seller_identity.identity_kind = 'user_id'
          and seller_identity.identity_hash = v_user_id_hash)
        or (seller_identity.identity_kind = 'username'
          and seller_identity.identity_hash = v_username_hash)
      )
  ) matched;

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

  delete from private.ebay_seller_identity_tenants seller_identity
  where seller_identity.user_id = any(v_seller_user_ids);

  return v_erased;
end;
$$;

revoke all on function public.erase_ebay_user_data(text, text)
  from public, anon, authenticated;
grant execute on function public.erase_ebay_user_data(text, text)
  to service_role;
