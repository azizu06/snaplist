-- Issue #252: keep Seller Home reads proportional to the current item set.
--
-- Home previously paged every tenant listing, item, and prediction log into the
-- Node process before reducing them to one row per current item. Prediction logs
-- are intentionally retained for evaluation, so that read grows without bound.

-- The pre-migration plan for one item with 2,000 retained predictions read and
-- sorted all 2,000 rows. This partial covering order lets the lateral LIMIT 1
-- stop at the latest usable price instead.
create index prediction_logs_home_latest_priced_idx
  on public.prediction_logs (user_id, item_id, created_at desc, id desc)
  where price is not null;

-- Source revision is part of the existing Home DTO contract. Preserve its
-- all-history meaning without aggregating the retained tables: each lookup is
-- tenant-prefixed and stops after the newest visible row.
create index items_home_revision_idx
  on public.items (user_id, (greatest(created_at, updated_at)) desc);

create index listings_home_ebay_revision_idx
  on public.listings (user_id, (greatest(created_at, updated_at)) desc)
  where platform = 'ebay';

create index prediction_logs_home_revision_idx
  on public.prediction_logs (user_id, created_at desc);

create view private.home_source_revision
with (security_invoker = true)
as
  select greatest(
    (
      select greatest(item.created_at, item.updated_at)
      from public.items as item
      where item.user_id = public.clerk_user_id()
      order by greatest(item.created_at, item.updated_at) desc
      limit 1
    ),
    (
      select greatest(listing.created_at, listing.updated_at)
      from public.listings as listing
      where listing.user_id = public.clerk_user_id()
        and listing.platform = 'ebay'
      order by greatest(listing.created_at, listing.updated_at) desc
      limit 1
    ),
    (
      select prediction.created_at
      from public.prediction_logs as prediction
      where prediction.user_id = public.clerk_user_id()
      order by prediction.created_at desc
      limit 1
    )
  ) as history_revision_at;

revoke all on private.home_source_revision from public, anon;
grant select on private.home_source_revision to authenticated;

create or replace function public.get_home_current_item_projection()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with current_item_rows as materialized (
    select
      item.id as item_id,
      item.user_id as item_user_id,
      item.attributes as item_attributes,
      item.photos as item_photos,
      item.price_override as item_price_override,
      item.cost_basis as item_cost_basis,
      item.created_at as item_created_at,
      item.updated_at as item_updated_at,
      listing.id as listing_id,
      listing.user_id as listing_user_id,
      listing.title as listing_title,
      listing.status as listing_status,
      listing.created_at as listing_created_at,
      listing.updated_at as listing_updated_at,
      listing.listed_price as listing_listed_price,
      prediction.id as prediction_id,
      prediction.user_id as prediction_user_id,
      prediction.price as prediction_price,
      prediction.created_at as prediction_created_at
    from public.items as item
    left join public.listings as listing
      on listing.user_id = item.user_id
     and listing.item_id = item.id
     and listing.platform = 'ebay'
    left join lateral (
      select
        candidate.id,
        candidate.user_id,
        candidate.price,
        candidate.created_at
      from public.prediction_logs as candidate
      where candidate.user_id = item.user_id
        and candidate.item_id = item.id
        and candidate.price is not null
      order by candidate.created_at desc, candidate.id desc
      limit 1
    ) as prediction on true
    where listing.id is null
       or listing.status <> 'archived'
       or exists (
         select 1
         from public.pipeline_runs as active_run
         where active_run.user_id = item.user_id
           and active_run.item_id = item.id
           and active_run.status in ('queued', 'running', 'retrying')
       )
  ),
  history_revision as (
    select revision.history_revision_at as revision_at
    from private.home_source_revision as revision
  )
  select jsonb_build_object(
    'history_revision_at', (select revision_at from history_revision),
    'items', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', row.item_id,
            'user_id', row.item_user_id,
            'attributes', row.item_attributes,
            'photos', row.item_photos,
            'price_override', row.item_price_override,
            'cost_basis', row.item_cost_basis,
            'created_at', row.item_created_at,
            'updated_at', row.item_updated_at
          )
          order by row.item_created_at desc, row.item_id desc
        )
        from current_item_rows as row
      ),
      '[]'::jsonb
    ),
    'listings', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', row.listing_id,
            'user_id', row.listing_user_id,
            'item_id', row.item_id,
            'title', row.listing_title,
            'status', row.listing_status,
            'created_at', row.listing_created_at,
            'updated_at', row.listing_updated_at,
            'listed_price', row.listing_listed_price
          )
          order by row.listing_created_at desc, row.listing_id desc
        )
        from current_item_rows as row
        where row.listing_id is not null
      ),
      '[]'::jsonb
    ),
    'predictions', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', row.prediction_id,
            'user_id', row.prediction_user_id,
            'item_id', row.item_id,
            'price', row.prediction_price,
            'created_at', row.prediction_created_at
          )
          order by row.prediction_created_at desc, row.prediction_id desc
        )
        from current_item_rows as row
        where row.prediction_id is not null
      ),
      '[]'::jsonb
    )
  );
$function$;

comment on function public.get_home_current_item_projection() is
  'RLS-scoped Seller Home rows: current items, their one eBay listing, and latest non-null prediction only. Accepts no tenant argument.';

revoke all on function public.get_home_current_item_projection() from public, anon;
grant execute on function public.get_home_current_item_projection() to authenticated;
