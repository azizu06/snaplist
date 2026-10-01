-- A finished item already posted to eBay opens the same SnapList listing as a
-- draft: the photos, copy, specifics, price, and sold comps SnapList wrote.
-- `get_mobile_listing_review` stays the draft-only read every edit path binds
-- to; this sibling reads only listings eBay has confirmed as published, under
-- the same run-bound, tenant-scoped RLS predicates. It grants no write, and the
-- client shows the live eBay page from eBay's own publication status.

create or replace function public.get_mobile_published_listing_review(p_run_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'run', jsonb_build_object(
      'id', run.id,
      'userId', run.user_id,
      'itemId', run.item_id,
      'listingId', run.listing_id,
      'status', run.status,
      'stage', run.stage
    ),
    'item', jsonb_build_object(
      'id', item.id,
      'userId', item.user_id,
      'photos', item.photos,
      'identification', item.identification,
      'condition', item.condition,
      'priceOverride', item.price_override,
      'reviewRevision', item.review_revision
    ),
    'listing', jsonb_build_object(
      'id', listing.id,
      'userId', listing.user_id,
      'itemId', listing.item_id,
      'runId', listing.run_id,
      'title', listing.title,
      'description', listing.description,
      'copy', listing.copy
    ),
    'pricingSnapshot', jsonb_build_object(
      'runId', pricing.run_id,
      'userId', pricing.user_id,
      'itemId', pricing.item_id,
      'listingId', pricing.listing_id,
      'schemaVersion', pricing.schema_version,
      'priceResult', pricing.price_result,
      'evidence', pricing.evidence,
      'evidenceAsOf', pricing.evidence_as_of
    )
  )
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  join public.listings listing
    on listing.id = run.listing_id
   and listing.item_id = run.item_id
   and listing.user_id = run.user_id
   and listing.platform = 'ebay'
  join public.pricing_evidence_snapshots pricing
    on pricing.run_id = listing.run_id
   and pricing.item_id = run.item_id
   and pricing.listing_id = run.listing_id
   and pricing.user_id = run.user_id
  where run.id = p_run_id
    and run.user_id = public.clerk_user_id()
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.listing_id is not null
    and item.review_revision is not null
    and listing.title is not null
    and btrim(listing.title) <> ''
    and listing.description is not null
    and btrim(listing.description) <> ''
    and listing.copy is not null
    and item.identification is not null
    and item.condition is not null
    and btrim(item.condition) <> ''
    and listing.ebay_listing_id is not null
    and listing.ebay_status = 'published'
  limit 1;
$$;

revoke all on function public.get_mobile_published_listing_review(uuid)
  from public, anon, service_role;
grant execute on function public.get_mobile_published_listing_review(uuid)
  to authenticated;
