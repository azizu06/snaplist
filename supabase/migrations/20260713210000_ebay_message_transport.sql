-- Issue #133: tenant-safe eBay pre-sale messaging transport.
--
-- This migration makes external message identity and delivery truth explicit,
-- adds a per-seller overlap cursor, and closes the remaining cross-tenant FK
-- holes on messages.item_id/listing_id. All user-facing paths remain protected
-- by Clerk RLS; the background scheduler uses the service role but pins every
-- statement to one explicit user_id.

-- ---------------------------------------------------------------------------
-- External identity + honest delivery state on messages.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists marketplace text not null default 'simulated',
  add column if not exists external_message_id text,
  add column if not exists external_parent_id text,
  add column if not exists external_conversation_id text,
  add column if not exists external_listing_id text,
  add column if not exists external_buyer_id text,
  add column if not exists external_created_at timestamptz,
  add column if not exists delivery_request_id text,
  add column if not exists delivery_status text,
  add column if not exists external_delivery_id text,
  add column if not exists delivery_attempted_at timestamptz,
  add column if not exists delivery_error text;

alter table public.messages
  drop constraint if exists messages_delivery_status_check;
alter table public.messages
  add constraint messages_delivery_status_check check (
    delivery_status is null or delivery_status in (
      'pending', 'sending', 'delivered', 'rejected', 'failed', 'ambiguous'
    )
  );

comment on column public.messages.external_parent_id is
  'Exact provider parent/question id required by the reply call. For eBay Trading this is GetMemberMessages Question.MessageID, never GetMyMessages mailbox MessageID.';
comment on column public.messages.delivery_request_id is
  'Stable local delivery correlation. It prevents duplicate local dispatch; eBay does not document Trading MessageID as an external idempotency token.';
comment on column public.messages.delivery_status is
  'External delivery truth: pending | sending | delivered | rejected | failed | ambiguous. sent_at is populated only after acknowledged delivery.';

-- Legacy simulated outbound rows were intentionally local successes. Preserve
-- that truth explicitly; inbound rows that were claimed but never gained a
-- canonical outbound row are ambiguous, not delivered.
update public.messages
set delivery_status = 'delivered',
    delivery_request_id = coalesce(delivery_request_id, id::text),
    delivery_attempted_at = coalesce(delivery_attempted_at, sent_at, updated_at)
where direction = 'outbound'
  and delivery_status is null
  and status = 'sent';

update public.messages inbound
set delivery_status = case
      when exists (
        select 1 from public.messages outbound
        where outbound.reply_to = inbound.id
          and outbound.user_id = inbound.user_id
          and outbound.direction = 'outbound'
          and (outbound.reply_kind is null or outbound.reply_kind = 'reply')
      ) then 'delivered'
      else 'ambiguous'
    end,
    delivery_request_id = coalesce(inbound.delivery_request_id, inbound.id::text),
    delivery_attempted_at = coalesce(
      inbound.delivery_attempted_at,
      inbound.sent_at,
      inbound.updated_at
    )
where inbound.direction = 'inbound'
  and inbound.status = 'sent'
  and inbound.delivery_status is null;

create unique index if not exists messages_external_identity_unique
  on public.messages (user_id, marketplace, external_message_id)
  where direction = 'inbound' and external_message_id is not null;

create unique index if not exists messages_delivery_request_unique
  on public.messages (user_id, delivery_request_id)
  where delivery_request_id is not null;

create index if not exists messages_external_listing_idx
  on public.messages (user_id, marketplace, external_listing_id);

-- One connected seller must never have two local rows claiming the same live
-- eBay ItemID; otherwise an imported question could map ambiguously.
do $assert_external_listing_unique$
declare
  duplicates text;
begin
  select string_agg(key, ', ' order by key)
  into duplicates
  from (
    select user_id || ':' || ebay_listing_id as key
    from public.listings
    where ebay_listing_id is not null
    group by user_id, ebay_listing_id
    having count(*) > 1
  ) unsafe;
  if duplicates is not null then
    raise exception using
      errcode = '23505',
      message = format(
        'Cannot enforce eBay listing identity: duplicate seller/listing ids exist: %s',
        duplicates
      );
  end if;
end;
$assert_external_listing_unique$;

create unique index if not exists listings_ebay_external_identity_unique
  on public.listings (user_id, ebay_listing_id)
  where ebay_listing_id is not null;

-- ---------------------------------------------------------------------------
-- Tenant-aware item/listing references for messages.
-- FK checks bypass RLS, so single-column references allowed a caller who knew
-- another tenant's UUID to attach their own message to that item/listing.
-- ---------------------------------------------------------------------------
create unique index if not exists listings_id_user_id_idx
  on public.listings (id, user_id);

do $assert_message_ownership$
declare
  malformed text;
begin
  select string_agg(message.id::text, ', ' order by message.id::text)
  into malformed
  from public.messages message
  join public.items item on item.id = message.item_id
  where message.item_id is not null
    and message.user_id is distinct from item.user_id;
  if malformed is not null then
    raise exception using errcode = '23503', message = format(
      'Cannot enforce message item ownership for message(s): %s', malformed
    );
  end if;

  select string_agg(message.id::text, ', ' order by message.id::text)
  into malformed
  from public.messages message
  join public.listings listing on listing.id = message.listing_id
  where message.listing_id is not null
    and message.user_id is distinct from listing.user_id;
  if malformed is not null then
    raise exception using errcode = '23503', message = format(
      'Cannot enforce message listing ownership for message(s): %s', malformed
    );
  end if;
end;
$assert_message_ownership$;

alter table public.messages drop constraint if exists messages_item_id_fkey;
alter table public.messages drop constraint if exists messages_listing_id_fkey;
alter table public.messages drop constraint if exists messages_item_user_fkey;
alter table public.messages drop constraint if exists messages_listing_user_fkey;

alter table public.messages
  add constraint messages_item_user_fkey
  foreign key (item_id, user_id)
  references public.items (id, user_id)
  on delete cascade;

alter table public.messages
  add constraint messages_listing_user_fkey
  foreign key (listing_id, user_id)
  references public.listings (id, user_id)
  on delete cascade;

-- ---------------------------------------------------------------------------
-- One deduplicated buyer-message notification per imported message.
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists source_message_id uuid;

alter table public.notifications
  drop constraint if exists notifications_source_message_user_fkey;
alter table public.notifications
  add constraint notifications_source_message_user_fkey
  foreign key (source_message_id, user_id)
  references public.messages (id, user_id)
  on delete cascade;

create unique index if not exists notifications_source_message_unique
  on public.notifications (user_id, source_message_id);

-- ---------------------------------------------------------------------------
-- Per-connected-seller overlap cursor and operational retry state.
-- ---------------------------------------------------------------------------
create table if not exists public.ebay_message_sync_state (
  -- No FK to ebay_connections: foreground sync must preserve the already-
  -- supported app-level Sandbox credential fallback when no per-user row exists.
  user_id text primary key,
  cursor_at timestamptz,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ebay_message_sync_state_set_updated_at
  before update on public.ebay_message_sync_state
  for each row execute function public.set_updated_at();

alter table public.ebay_message_sync_state enable row level security;
create policy ebay_message_sync_state_select_own
  on public.ebay_message_sync_state for select to authenticated
  using (public.clerk_user_id() = user_id);
create policy ebay_message_sync_state_insert_own
  on public.ebay_message_sync_state for insert to authenticated
  with check (public.clerk_user_id() = user_id);
create policy ebay_message_sync_state_update_own
  on public.ebay_message_sync_state for update to authenticated
  using (public.clerk_user_id() = user_id)
  with check (public.clerk_user_id() = user_id);
create policy ebay_message_sync_state_delete_own
  on public.ebay_message_sync_state for delete to authenticated
  using (public.clerk_user_id() = user_id);
