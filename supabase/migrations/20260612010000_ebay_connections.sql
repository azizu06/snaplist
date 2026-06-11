-- Per-user eBay OAuth connections (issue #17 — production go-live).
--
-- One row per SnapList user holding their eBay refresh/access tokens, both
-- encrypted at rest with AES-256-GCM (key = EBAY_TOKEN_ENCRYPTION_KEY env,
-- never in the database). The eBay identity columns (ebay_user_id, username)
-- exist so the Marketplace Account Deletion endpoint can map an eBay deletion
-- notice back to the stored tokens and erase them.
--
-- Tenancy follows the post-#41 pattern: text user_id = Clerk id, RLS keyed on
-- public.clerk_user_id(). The token columns hold CIPHERTEXT, so an owner
-- reading their own row never exposes a usable credential — decryption needs
-- the server-held key.

create table public.ebay_connections (
  user_id                 text primary key,
  ebay_user_id            text,
  ebay_username           text,
  -- AES-256-GCM payloads ("v1.<iv>.<ct>.<tag>"), see src/lib/crypto/secretbox.ts
  refresh_token_enc       text not null,
  access_token_enc        text,
  access_token_expires_at timestamptz,
  scopes                  text[] not null default '{}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.ebay_connections is
  'Per-user eBay OAuth tokens (encrypted at rest; issue #17). ebay_user_id/ebay_username let the account-deletion endpoint erase by eBay identity.';

-- The deletion endpoint looks connections up by eBay identity (service role).
create index ebay_connections_ebay_user_id_idx on public.ebay_connections (ebay_user_id);
create index ebay_connections_ebay_username_idx on public.ebay_connections (ebay_username);

create trigger ebay_connections_set_updated_at
  before update on public.ebay_connections
  for each row execute function public.set_updated_at();

alter table public.ebay_connections enable row level security;

create policy ebay_connections_select_own on public.ebay_connections
  for select to authenticated using (public.clerk_user_id() = user_id);
create policy ebay_connections_insert_own on public.ebay_connections
  for insert to authenticated with check (public.clerk_user_id() = user_id);
create policy ebay_connections_update_own on public.ebay_connections
  for update to authenticated using (public.clerk_user_id() = user_id)
  with check (public.clerk_user_id() = user_id);
create policy ebay_connections_delete_own on public.ebay_connections
  for delete to authenticated using (public.clerk_user_id() = user_id);
