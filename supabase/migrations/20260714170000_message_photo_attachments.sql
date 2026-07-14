-- #134: tenant-owned image attachments for supported eBay pre-sale messages.
-- Binary objects are private. Rows are tied to the same tenant as both the
-- conversation root and, once visible, the concrete message they decorate.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-photos',
  'message-photos',
  false,
  12582912,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  conversation_root_id uuid not null,
  message_id uuid,
  delivery_request_id text not null,
  position smallint not null check (position between 0 and 4),
  direction text not null check (direction in ('inbound', 'outbound')),
  media_type text check (media_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer check (byte_size is null or byte_size between 1 and 12582912),
  original_name text not null check (char_length(original_name) between 1 and 100),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text,
  provider_media_id text,
  provider_url text check (provider_url is null or provider_url ~ '^https://'),
  provider_expires_at timestamptz,
  delivery_status text not null default 'staged'
    check (delivery_status in ('staged', 'uploaded', 'delivered', 'rejected', 'failed', 'ambiguous')),
  delivery_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_attachments_id_user_id_key unique (id, user_id),
  constraint message_attachments_root_tenant_fkey
    foreign key (conversation_root_id, user_id)
    references public.messages (id, user_id) on delete cascade,
  constraint message_attachments_message_tenant_fkey
    foreign key (message_id, user_id)
    references public.messages (id, user_id) on delete cascade,
  constraint message_attachments_storage_path_shape
    check (storage_path is null or storage_path like user_id || '/%'),
  constraint message_attachments_direction_message_check
    check (
      (direction = 'inbound' and message_id = conversation_root_id)
      or (direction = 'outbound' and media_type is not null and (message_id is null or message_id <> conversation_root_id))
    )
);

create unique index message_attachments_request_position_unique
  on public.message_attachments (user_id, delivery_request_id, position);
create index message_attachments_message_idx
  on public.message_attachments (user_id, message_id, position);
create index message_attachments_conversation_idx
  on public.message_attachments (user_id, conversation_root_id, created_at);

alter table public.message_attachments enable row level security;

create policy "message_attachments_select_own"
  on public.message_attachments for select
  using (user_id = public.clerk_user_id());
create policy "message_attachments_insert_own"
  on public.message_attachments for insert
  with check (
    user_id = public.clerk_user_id()
    and (
      (
        direction = 'outbound'
        and message_id is null
        and media_type is not null
        and byte_size is not null
        and content_sha256 is not null
        and storage_path is not null
        and provider_media_id is null
        and provider_url is null
        and provider_expires_at is null
        and delivery_status = 'staged'
        and delivery_error is null
      )
      or (
        direction = 'inbound'
        and message_id = conversation_root_id
        and media_type is null
        and byte_size is null
        and content_sha256 is null
        and storage_path is null
        and provider_media_id is null
        and provider_url is not null
        and provider_expires_at is null
        and delivery_status = 'delivered'
        and delivery_error is null
        and coalesce(
          (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
          ''
        ) like 'sb_secret_%'
      )
    )
  );

-- Provider references and delivery truth are server-managed. Authenticated
-- clients can stage a validated intent and read their rows, but cannot forge
-- an EPS URL, mark delivery, rethread media, or delete audit metadata.
create policy "message_attachments_update_server_own"
  on public.message_attachments for update
  using (user_id = public.clerk_user_id())
  with check (user_id = public.clerk_user_id());

create or replace function private.enforce_message_attachment_server_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') not in ('authenticated', 'service_role')
    or v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server authorization is required for attachment delivery state';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_message_attachment_server_update()
  from public, anon, authenticated, service_role;

create trigger message_attachments_server_update
  before update on public.message_attachments
  for each row execute function private.enforce_message_attachment_server_update();

create policy "message_photos_select_own"
  on storage.objects for select
  using (
    bucket_id = 'message-photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );
create policy "message_photos_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'message-photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );
create policy "message_photos_update_own"
  on storage.objects for update
  using (
    bucket_id = 'message-photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  )
  with check (
    bucket_id = 'message-photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );
create policy "message_photos_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'message-photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

alter publication supabase_realtime add table public.message_attachments;

create trigger message_attachments_updated_at
  before update on public.message_attachments
  for each row execute function public.set_updated_at();

-- Complete the already-acknowledged provider write and expose its attachments
-- in one transaction. This delegates the message lifecycle to #140's exact
-- generation/attempt checks, then links every staged provider reference before
-- either change can become visible over Realtime.
create or replace function public.complete_ebay_message_write_with_photos(
  p_operation text,
  p_payload jsonb,
  p_generation uuid,
  p_delivery_request_id text
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
  v_result jsonb;
  v_message_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or v_user_id = ''
    or v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server seller authorization is required';
  end if;
  if p_operation not in ('complete_canonical', 'complete_followup') then
    raise exception using errcode = '42501', message = 'Photo completion operation is not allowed';
  end if;
  if exists (
    select 1
    from public.message_attachments attachment
    where attachment.user_id = v_user_id
      and attachment.delivery_request_id = p_delivery_request_id
      and attachment.direction = 'outbound'
      and (
        attachment.provider_media_id is null
        or attachment.provider_url is null
      )
  ) then
    raise exception using errcode = '23514', message = 'Every photo must be hosted before message completion';
  end if;

  v_result := private.apply_authenticated_ebay_message_write(
    p_operation,
    p_payload,
    p_generation
  );
  v_message_id := nullif(v_result->>'id', '')::uuid;
  if v_message_id is null then
    raise exception using errcode = 'P0001', message = 'Message completion returned no message id';
  end if;

  update public.message_attachments attachment
  set message_id = v_message_id,
      delivery_status = 'delivered',
      delivery_error = null,
      updated_at = statement_timestamp()
  where attachment.user_id = v_user_id
    and attachment.delivery_request_id = p_delivery_request_id
    and attachment.direction = 'outbound';

  return v_result;
end;
$$;

revoke all on function public.complete_ebay_message_write_with_photos(
  text, jsonb, uuid, text
) from public, anon, service_role;
grant execute on function public.complete_ebay_message_write_with_photos(
  text, jsonb, uuid, text
) to authenticated;

create table private.message_photo_object_deletion_queue (
  storage_path text primary key,
  enqueued_at timestamptz not null default statement_timestamp()
);

revoke all on table private.message_photo_object_deletion_queue
  from public, anon, authenticated, service_role;

create or replace function private.queue_message_photo_object_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.storage_path is not null then
    insert into private.message_photo_object_deletion_queue (storage_path)
    values (old.storage_path)
    on conflict (storage_path) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function private.queue_message_photo_object_deletion()
  from public, anon, authenticated, service_role;

create trigger message_attachments_queue_object_deletion
  after delete on public.message_attachments
  for each row execute function private.queue_message_photo_object_deletion();

create or replace function public.list_message_photo_object_deletions()
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Account deletion authorization is required';
  end if;
  return array(
    select queue.storage_path
    from private.message_photo_object_deletion_queue queue
    order by queue.enqueued_at
  );
end;
$$;

revoke all on function public.list_message_photo_object_deletions()
  from public, anon, authenticated;
grant execute on function public.list_message_photo_object_deletions()
  to service_role;

create or replace function public.complete_message_photo_object_deletions(
  p_storage_paths text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Account deletion authorization is required';
  end if;
  delete from private.message_photo_object_deletion_queue queue
  where queue.storage_path = any(coalesce(p_storage_paths, '{}'::text[]));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.complete_message_photo_object_deletions(text[])
  from public, anon, authenticated;
grant execute on function public.complete_message_photo_object_deletions(text[])
  to service_role;
