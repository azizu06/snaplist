-- Issue #566. One monotonic completion marker for the signed-in seller's
-- first-listing activation guidance. The client may opt out, but it can never
-- write, read, reset, or replay another seller's marker.
create table public.activation_guidance_completions (
  user_id text primary key,
  completed_at timestamp with time zone not null default statement_timestamp()
);

comment on table public.activation_guidance_completions is
  'Tenant-scoped, monotonic completion marker for first-listing activation guidance.';

alter table public.activation_guidance_completions enable row level security;

revoke all on table public.activation_guidance_completions
  from public, anon, authenticated, service_role;
grant select, insert on table public.activation_guidance_completions to authenticated;
grant delete on table public.activation_guidance_completions to service_role;

create policy activation_guidance_completions_select_own
  on public.activation_guidance_completions
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create policy activation_guidance_completions_insert_own
  on public.activation_guidance_completions
  for insert
  to authenticated
  with check ((select public.clerk_user_id()) = user_id);
