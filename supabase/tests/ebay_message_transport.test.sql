begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(25);

insert into public.items (id, user_id, attributes)
values
  ('91000000-0000-4000-8000-000000000001', 'message-tenant-a', '{}'),
  ('91000000-0000-4000-8000-000000000002', 'message-tenant-b', '{}');

insert into public.listings (
  id, user_id, item_id, platform, title, status, ebay_listing_id, ebay_status
)
values
  (
    '92000000-0000-4000-8000-000000000001',
    'message-tenant-a',
    '91000000-0000-4000-8000-000000000001',
    'ebay',
    'Tenant A listing',
    'published',
    'sandbox-item-a',
    'published'
  ),
  (
    '92000000-0000-4000-8000-000000000002',
    'message-tenant-b',
    '91000000-0000-4000-8000-000000000002',
    'ebay',
    'Tenant B listing',
    'published',
    'sandbox-item-b',
    'published'
  );

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, marketplace,
  external_message_id, external_parent_id, external_conversation_id,
  external_listing_id, external_buyer_id
)
values
  (
    '93000000-0000-4000-8000-000000000001',
    'message-tenant-a',
    '91000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    'inbound',
    'Question A',
    'drafted',
    'ebay',
    'shared-provider-id',
    'exact-parent-a',
    'conversation-a',
    'sandbox-item-a',
    'buyer-a'
  ),
  (
    '93000000-0000-4000-8000-000000000002',
    'message-tenant-b',
    '91000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000002',
    'inbound',
    'Question B',
    'drafted',
    'ebay',
    'shared-provider-id',
    'exact-parent-b',
    'conversation-b',
    'sandbox-item-b',
    'buyer-b'
  );

select extensions.is(
  (select count(*)::integer from public.messages where external_message_id = 'shared-provider-id'),
  2,
  'external message identity is unique per tenant, not globally'
);

insert into public.ebay_message_sync_state (user_id, cursor_at)
values
  ('message-tenant-a', '2026-07-13T12:00:00Z'),
  ('message-tenant-b', '2026-07-13T12:00:00Z');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-a","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select extensions.is(
  (select count(*)::integer from public.messages where user_id = 'message-tenant-a'),
  1,
  'tenant A can view its imported question'
);

select extensions.is(
  (select count(*)::integer from public.messages where user_id = 'message-tenant-b'),
  0,
  'tenant A cannot view tenant B messages'
);

select extensions.is(
  (select count(*)::integer from public.ebay_message_sync_state),
  1,
  'tenant A sees only its own sync cursor'
);

select extensions.throws_ok(
  $$
    insert into public.ebay_message_sync_state (user_id)
    values ('message-tenant-b-spoof')
  $$,
  '42501',
  null,
  'tenant A cannot create another seller sync cursor'
);

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, item_id, listing_id, direction, body, status
    ) values (
      'message-tenant-a',
      '91000000-0000-4000-8000-000000000002',
      '92000000-0000-4000-8000-000000000002',
      'inbound',
      'cross-tenant attach',
      'new'
    )
  $$,
  '23503',
  null,
  'tenant-composite item/listing FKs reject a cross-tenant message'
);

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, direction, body, status, reply_to, reply_kind
    ) values (
      'message-tenant-a',
      'outbound',
      'attempted cross-tenant send',
      'sent',
      '93000000-0000-4000-8000-000000000002',
      'reply'
    )
  $$,
  '23503',
  null,
  'tenant A cannot thread or send against tenant B question identity'
);

select extensions.throws_ok(
  $$
    insert into public.notifications (
      user_id, kind, title, source_message_id
    ) values (
      'message-tenant-a',
      'buyer_message',
      'foreign source',
      '93000000-0000-4000-8000-000000000002'
    )
  $$,
  '23503',
  null,
  'tenant A cannot attach a notification to tenant B message'
);

reset role;

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, direction, body, status, marketplace, external_message_id
    ) values (
      'message-tenant-a',
      'inbound',
      'duplicate import',
      'new',
      'ebay',
      'shared-provider-id'
    )
  $$,
  '23505',
  null,
  'the same provider question cannot import twice in one tenant'
);

set local role authenticated;

select extensions.lives_ok(
  $$
    insert into public.notifications (
      user_id, kind, title, source_message_id
    ) values (
      'message-tenant-a',
      'buyer_message',
      'own source',
      '93000000-0000-4000-8000-000000000001'
    )
  $$,
  'tenant A can create its own message notification'
);

select extensions.throws_ok(
  $$
    insert into public.notifications (
      user_id, kind, title, source_message_id
    ) values (
      'message-tenant-a',
      'buyer_message',
      'duplicate own source',
      '93000000-0000-4000-8000-000000000001'
    )
  $$,
  '23505',
  null,
  'replay cannot create a duplicate notification'
);

select extensions.results_eq(
  $$
    with attempted as (
      update public.messages
      set delivery_status = 'sending'
      where id = '93000000-0000-4000-8000-000000000002'
      returning id
    )
    select count(*)::bigint from attempted
  $$,
  'values (0::bigint)',
  'tenant A cannot claim tenant B delivery for send'
);

select extensions.results_eq(
  $$
    with attempted as (
      update public.ebay_message_sync_state
      set cursor_at = '2026-07-13T13:00:00Z'
      where user_id = 'message-tenant-b'
      returning user_id
    )
    select count(*)::bigint from attempted
  $$,
  'values (0::bigint)',
  'tenant A cannot advance tenant B sync cursor'
);

select extensions.results_eq(
  $$
    with attempted as (
      update public.messages
      set status = 'new', draft_reply = null
      where id = '93000000-0000-4000-8000-000000000001'
      returning id
    )
    select count(*)::bigint from attempted
  $$,
  'values (0::bigint)',
  'tenant A cannot reset a server-managed eBay draft lifecycle'
);

select extensions.results_eq(
  $$
    select public.apply_ebay_message_write(
      'claim_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000001',
        'body', 'Direct client reply',
        'at', '2026-07-13T12:05:00Z',
        'retry', false
      )
    )
  $$,
  $$values ('true'::jsonb)$$,
  'the foreground write seam derives tenant A from the Clerk JWT'
);

select extensions.results_eq(
  $$
    select public.apply_ebay_message_write(
      'claim_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000002',
        'body', 'Cross-tenant reply',
        'at', '2026-07-13T12:05:00Z',
        'retry', false
      )
    )
  $$,
  $$values ('false'::jsonb)$$,
  'the foreground write seam cannot claim another Clerk tenant message'
);

select extensions.throws_ok(
  $$
    select private.apply_ebay_message_write_for_tenant(
      'message-tenant-b',
      'sync_mark_attempt',
      '{"at":"2026-07-13T12:05:00Z"}'::jsonb
    )
  $$,
  '42501',
  null,
  'an authenticated tenant cannot invoke the arbitrary-tenant helper'
);

select set_config(
  'request.headers',
  '{"apikey":"sb_publishable_local_test"}',
  true
);

select extensions.throws_ok(
  $$
    select public.apply_ebay_message_write(
      'sync_mark_attempt',
      '{"at":"2026-07-13T12:05:00Z"}'::jsonb
    )
  $$,
  '42501',
  null,
  'a browser API key cannot invoke server-owned eBay lifecycle writes'
);

select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, item_id, listing_id, direction, body, status, marketplace,
      external_message_id
    ) values (
      'message-tenant-a',
      '91000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000001',
      'inbound',
      'fabricated eBay question',
      'new',
      'ebay',
      'fabricated-provider-id'
    )
  $$,
  '42501',
  null,
  'tenant A cannot fabricate an eBay draft candidate'
);

select extensions.lives_ok(
  $$
    insert into public.messages (
      user_id, item_id, listing_id, direction, body, status, marketplace
    ) values (
      'message-tenant-a',
      '91000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000001',
      'inbound',
      'simulated question',
      'new',
      'simulated'
    )
  $$,
  'tenant A can still create its own simulated message'
);

reset role;

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

select extensions.throws_ok(
  $$
    select public.apply_ebay_message_write(
      'claim_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000001',
        'body', 'Tenant A approved reply',
        'at', '2026-07-13T12:05:00Z',
        'retry', false
      )
    )
  $$,
  '42501',
  null,
  'the scheduler cannot invoke the foreground tenant write seam'
);

select extensions.throws_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
      'message-tenant-a',
      'claim_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000002',
        'body', 'Cross-tenant reply',
        'at', '2026-07-13T12:05:00Z',
        'retry', false
      )
    )
  $$,
  '42501',
  null,
  'scheduler authority cannot perform seller delivery operations'
);

select extensions.lives_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
      'message-tenant-b',
      'sync_mark_attempt',
      '{"at":"2026-07-13T12:05:00Z"}'::jsonb
    )
  $$,
  'the scheduler can advance a selected seller sync lifecycle'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-a","role":"authenticated"}',
  true
);

select extensions.lives_ok(
  $$
    insert into public.messages (
      user_id, item_id, listing_id, direction, body, status, reply_to,
      reply_kind, marketplace, delivery_request_id, delivery_status
    ) values (
      'message-tenant-a',
      '91000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000001',
      'outbound',
      'Tenant A reply',
      'sent',
      '93000000-0000-4000-8000-000000000001',
      'reply',
      'ebay',
      'delivery-a',
      'delivered'
    )
  $$,
  'the trusted server can persist a delivered eBay reply'
);

set local role authenticated;

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, direction, body, status, reply_kind, delivery_request_id,
      delivery_status
    ) values (
      'message-tenant-a',
      'outbound',
      'duplicate dispatch intent',
      'approved',
      'followup',
      'delivery-a',
      'sending'
    )
  $$,
  '23505',
  null,
  'a replayed delivery request cannot create a second outbound intent'
);

select * from extensions.finish();
rollback;
