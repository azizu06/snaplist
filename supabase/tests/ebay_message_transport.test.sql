begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(123);

create function pg_temp.apply_ebay_message_write(
  p_operation text,
  p_payload jsonb
)
returns jsonb
language sql
as $$
  select public.apply_ebay_message_write(
    p_operation,
    p_payload,
    public.begin_ebay_message_write()
  )
$$;

create function pg_temp.apply_scheduled_ebay_message_write(
  p_user_id text,
  p_operation text,
  p_payload jsonb
)
returns jsonb
language sql
as $$
  select public.apply_scheduled_ebay_message_write(
    p_user_id,
    p_operation,
    p_payload,
    public.begin_scheduled_ebay_message_write(p_user_id)
  )
$$;

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

select extensions.throws_ok(
  $$
    insert into public.messages (
      user_id, item_id, listing_id, direction, body, status, reply_to,
      marketplace, delivery_status
    ) values (
      'message-tenant-a',
      '91000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000001',
      'outbound',
      'Spoofed local delivery',
      'sent',
      '93000000-0000-4000-8000-000000000001',
      'simulated',
      'delivered'
    )
  $$,
  '23514',
  null,
  'a simulated reply cannot claim an eBay question'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages reply
    where reply.reply_to = '93000000-0000-4000-8000-000000000001'
  ),
  0,
  'a rejected cross-marketplace reply cannot occupy the canonical reply slot'
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

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'import_question',
      jsonb_build_object(
        'item_id', '91000000-0000-4000-8000-000000000001',
        'listing_id', '92000000-0000-4000-8000-000000000001',
        'body', 'Was this answered directly?',
        'external_message_id', 'externally-answered-question-a',
        'external_parent_id', 'externally-answered-question-a',
        'external_conversation_id', 'conversation-external-answer-a',
        'external_listing_id', 'sandbox-item-a',
        'external_buyer_id', 'buyer-external-answer-a',
        'external_created_at', '2026-07-13T11:58:00Z'
      )
    )
  $$,
  'reconciliation can import an actionable eBay question'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'mark_externally_answered',
      jsonb_build_object(
        'external_message_id', 'externally-answered-question-a'
      )
    )
  $$,
  'reconciliation can retire an eBay question answered outside SnapList'
);

select extensions.results_eq(
  $$
    select status, draft_reply, draft_model
    from public.messages
    where external_message_id = 'externally-answered-question-a'
  $$,
  $$values ('externally_answered'::text, null::text, null::text)$$,
  'an externally answered question is durable and non-actionable'
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Did the listing end?',
    'external_message_id', 'provider-unavailable-question-a',
    'external_parent_id', 'provider-unavailable-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-a',
    'external_created_at', '2026-07-13T11:59:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'expected_status', 'new'
  )
);

select pg_temp.apply_ebay_message_write(
  'attach_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'draft_reply', 'The charger is included.',
    'draft_model', 'test-reply'
  )
);

select pg_temp.apply_ebay_message_write(
  'mark_provider_unavailable',
  jsonb_build_object(
    'external_message_id', 'provider-unavailable-question-a',
    'at', '2026-07-13T12:10:00Z'
  )
);

select extensions.results_eq(
  $$
    select status, draft_reply, draft_model
    from public.messages
    where external_message_id = 'provider-unavailable-question-a'
  $$,
  $$values ('provider_unavailable'::text, 'The charger is included.'::text, 'test-reply'::text)$$,
  'ambiguous provider absence is neutral and preserves seller-visible history'
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Did the listing end?',
    'external_message_id', 'provider-unavailable-question-a',
    'external_parent_id', 'provider-unavailable-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-a',
    'external_created_at', '2026-07-13T11:59:00Z'
  )
);

select extensions.results_eq(
  $$
    select status, draft_reply, draft_model
    from public.messages
    where external_message_id = 'provider-unavailable-question-a'
  $$,
  $$values ('drafted'::text, 'The charger is included.'::text, 'test-reply'::text)$$,
  'fresh unanswered evidence restores a neutralized draft without regenerating it'
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Is this available again?',
    'external_message_id', 'provider-unavailable-new-question-a',
    'external_parent_id', 'provider-unavailable-new-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-new-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-new-a',
    'external_created_at', '2026-07-13T12:01:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'mark_provider_unavailable',
  jsonb_build_object(
    'external_message_id', 'provider-unavailable-new-question-a',
    'at', '2026-07-13T12:10:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Is this available again?',
    'external_message_id', 'provider-unavailable-new-question-a',
    'external_parent_id', 'provider-unavailable-new-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-new-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-new-a',
    'external_created_at', '2026-07-13T12:01:00Z'
  )
);

select extensions.results_eq(
  $$
    select status, draft_reply, delivery_status
    from public.messages
    where external_message_id = 'provider-unavailable-new-question-a'
  $$,
  $$values ('new'::text, null::text, null::text)$$,
  'fresh unanswered evidence restores a neutralized undrafted question'
);

select pg_temp.apply_ebay_message_write(
  'claim_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'body', 'The charger is included.',
    'at', '2026-07-13T12:20:00Z',
    'retry', false
  )
);

select pg_temp.apply_ebay_message_write(
  'fail_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'kind', 'ambiguous',
    'attempted_at', '2026-07-13T12:20:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'mark_provider_unavailable',
  jsonb_build_object(
    'external_message_id', 'provider-unavailable-question-a',
    'at', '2026-07-13T12:30:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Did the listing end?',
    'external_message_id', 'provider-unavailable-question-a',
    'external_parent_id', 'provider-unavailable-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-a',
    'external_created_at', '2026-07-13T11:59:00Z'
  )
);

select extensions.results_eq(
  $$
    select status, draft_reply, delivery_status, delivery_attempted_at
    from public.messages
    where external_message_id = 'provider-unavailable-question-a'
  $$,
  $$
    values (
      'sent'::text,
      'The charger is included.'::text,
      'ambiguous'::text,
      '2026-07-13T12:20:00Z'::timestamptz
    )
  $$,
  'fresh unanswered evidence restores unacknowledged delivery retry state'
);

select pg_temp.apply_ebay_message_write(
  'claim_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'body', 'The charger is included.',
    'at', '2026-07-13T12:31:00Z',
    'retry', true
  )
);

select pg_temp.apply_ebay_message_write(
  'complete_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'body', 'The charger is included.',
    'external_delivery_id', 'provider-unavailable-delivery-a',
    'delivered_at', '2026-07-13T12:32:00Z',
    'attempted_at', '2026-07-13T12:31:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Did the listing end?',
    'external_message_id', 'provider-unavailable-question-a',
    'external_parent_id', 'provider-unavailable-question-a',
    'external_conversation_id', 'conversation-provider-unavailable-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-provider-unavailable-a',
    'external_created_at', '2026-07-13T11:59:00Z'
  )
);

select extensions.results_eq(
  $$
    select root.status, root.delivery_status, reply.external_delivery_id
    from public.messages root
    join public.messages reply on reply.reply_to = root.id
    where root.external_message_id = 'provider-unavailable-question-a'
      and reply.direction = 'outbound'
      and reply.reply_kind = 'reply'
  $$,
  $$
    values (
      'sent'::text,
      'delivered'::text,
      'provider-unavailable-delivery-a'::text
    )
  $$,
  'unanswered replay cannot alter an acknowledged delivery'
);

select pg_temp.apply_ebay_message_write(
  'upsert_unresolved_question',
  jsonb_build_object(
    'external_message_id', 'partial-question-a',
    'external_parent_id', 'partial-question-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', null,
    'body', null,
    'subject', null,
    'external_created_at', null,
    'resolution_window_from', '2026-07-13T12:00:00Z',
    'observed_cursor_at', '2026-07-13T12:05:00Z',
    'attempted_at', '2026-07-13T12:05:00Z',
    'error', 'Required Trading fields were missing'
  )
);

select extensions.results_eq(
  $$
    select external_message_id, external_listing_id, external_buyer_id,
           body, external_created_at, resolution_status
    from public.ebay_unresolved_questions
    where external_message_id = 'partial-question-a'
  $$,
  $$
    values (
      'partial-question-a'::text,
      'sandbox-item-a'::text,
      null::text,
      null::text,
      null::timestamptz,
      'pending'::text
    )
  $$,
  'stable partial Trading identity remains durable for later resolution'
);

select pg_temp.apply_ebay_message_write(
  'upsert_unresolved_question',
  jsonb_build_object(
    'external_message_id', 'partial-question-a',
    'external_parent_id', 'partial-question-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-partial-a',
    'body', 'Can this now be resolved?',
    'subject', 'Question about item',
    'external_created_at', '2026-07-13T12:01:00Z',
    'resolution_window_from', '2026-07-13T12:00:00Z',
    'observed_cursor_at', '2026-07-13T12:10:00Z',
    'attempted_at', '2026-07-13T12:10:00Z',
    'error', 'Conversation resolution still pending'
  )
);

select extensions.results_eq(
  $$
    select external_buyer_id, body, subject, external_created_at,
           resolution_attempts
    from public.ebay_unresolved_questions
    where external_message_id = 'partial-question-a'
  $$,
  $$
    values (
      'buyer-partial-a'::text,
      'Can this now be resolved?'::text,
      'Question about item'::text,
      '2026-07-13T12:01:00Z'::timestamptz,
      2
    )
  $$,
  'a replay can safely enrich missing fields on the stable pending identity'
);

select pg_temp.apply_ebay_message_write(
  'retire_unresolved_question',
  jsonb_build_object(
    'external_message_id', 'partial-question-a',
    'outcome', 'provider_unavailable',
    'at', '2026-07-13T12:10:00Z'
  )
);

select extensions.results_eq(
  $$
    select resolution_status, count(*)::integer
    from public.ebay_unresolved_questions
    where external_message_id = 'partial-question-a'
    group by resolution_status
  $$,
  $$values ('provider_unavailable'::text, 1)$$,
  'neutral reconciliation retires pending work without deleting its identity'
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Did the ambiguous reply arrive?',
    'external_message_id', 'ambiguous-question-a',
    'external_parent_id', 'ambiguous-question-a',
    'external_conversation_id', 'conversation-ambiguous-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-ambiguous-a',
    'external_created_at', '2026-07-11T11:58:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'ambiguous-question-a'
    ),
    'expected_status', 'new'
  )
);

select pg_temp.apply_ebay_message_write(
  'attach_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'ambiguous-question-a'
    ),
    'draft_reply', 'The charger is included.',
    'draft_model', 'test-reply'
  )
);

select pg_temp.apply_ebay_message_write(
  'claim_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'ambiguous-question-a'
    ),
    'body', 'The charger is included.',
    'at', '2026-07-13T12:06:00Z',
    'retry', false
  )
);

select pg_temp.apply_ebay_message_write(
  'fail_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'ambiguous-question-a'
    ),
    'kind', 'ambiguous',
    'attempted_at', '2026-07-13T12:06:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'mark_externally_answered',
  jsonb_build_object('external_message_id', 'ambiguous-question-a')
);

select extensions.results_eq(
  $$
    select status, draft_reply, delivery_status, delivery_attempted_at
    from public.messages
    where external_message_id = 'ambiguous-question-a'
  $$,
  $$
    values (
      'externally_answered'::text,
      'The charger is included.'::text,
      'ambiguous'::text,
      '2026-07-13T12:06:00Z'::timestamptz
    )
  $$,
  'reconciliation retires an unacknowledged send while preserving its history'
);

select extensions.results_eq(
  $$
    select pg_temp.apply_ebay_message_write(
      'claim_canonical',
      jsonb_build_object(
        'message_id', (
          select id from public.messages
          where external_message_id = 'ambiguous-question-a'
        ),
        'body', 'The charger is included.',
        'at', '2026-07-13T12:12:00Z',
        'retry', true
      )
    )
  $$,
  $$values ('false'::jsonb)$$,
  'an externally answered send cannot be retried into a duplicate delivery'
);

select pg_temp.apply_ebay_message_write(
  'import_question',
  jsonb_build_object(
    'item_id', '91000000-0000-4000-8000-000000000001',
    'listing_id', '92000000-0000-4000-8000-000000000001',
    'body', 'Is the active send still unanswered?',
    'external_message_id', 'active-send-question-a',
    'external_parent_id', 'active-send-question-a',
    'external_conversation_id', 'conversation-active-send-a',
    'external_listing_id', 'sandbox-item-a',
    'external_buyer_id', 'buyer-active-send-a',
    'external_created_at', '2026-07-13T12:07:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'active-send-question-a'
    ),
    'expected_status', 'new'
  )
);

select pg_temp.apply_ebay_message_write(
  'attach_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'active-send-question-a'
    ),
    'draft_reply', 'The active send reply.',
    'draft_model', 'test-reply'
  )
);

select pg_temp.apply_ebay_message_write(
  'claim_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'active-send-question-a'
    ),
    'body', 'The active send reply.',
    'at', '2026-07-13T12:08:00Z',
    'retry', false
  )
);

select pg_temp.apply_ebay_message_write(
  'mark_externally_answered',
  jsonb_build_object(
    'external_message_id', 'active-send-question-a',
    'at', '2026-07-13T12:10:00Z'
  )
);

select extensions.results_eq(
  $$
    select status, draft_reply, delivery_status, delivery_attempted_at
    from public.messages
    where external_message_id = 'active-send-question-a'
  $$,
  $$
    values (
      'sent'::text,
      'The active send reply.'::text,
      'sending'::text,
      '2026-07-13T12:08:00Z'::timestamptz
    )
  $$,
  'reconciliation cannot retire a fresh active delivery lease'
);

select pg_temp.apply_ebay_message_write(
  'mark_externally_answered',
  jsonb_build_object(
    'external_message_id', 'active-send-question-a',
    'at', '2026-07-13T12:14:00Z'
  )
);

select pg_temp.apply_ebay_message_write(
  'complete_canonical',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'active-send-question-a'
    ),
    'body', 'The active send reply.',
    'external_delivery_id', 'late-active-send-acknowledgement',
    'delivered_at', '2026-07-13T12:15:00Z',
    'attempted_at', '2026-07-13T12:08:00Z'
  )
);

select extensions.results_eq(
  $$
    select root.status, root.delivery_status, reply.external_delivery_id
    from public.messages root
    join public.messages reply on reply.reply_to = root.id
    where root.external_message_id = 'active-send-question-a'
      and reply.direction = 'outbound'
      and reply.reply_kind = 'reply'
  $$,
  $$
    values (
      'sent'::text,
      'delivered'::text,
      'late-active-send-acknowledgement'::text
    )
  $$,
  'a valid late acknowledgement restores coherent delivered state'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'upsert_unresolved_question',
      jsonb_build_object(
        'external_message_id', 'unresolved-question-a',
        'external_parent_id', 'unresolved-question-a',
        'external_listing_id', 'sandbox-item-a',
        'external_buyer_id', 'buyer-unresolved-a',
        'body', 'Does this include the case?',
        'subject', 'Case question',
        'external_created_at', '2026-07-13T11:59:00Z',
        'resolution_window_from', '2026-07-12T12:00:00Z',
        'observed_cursor_at', '2026-07-13T12:00:00Z',
        'attempted_at', '2026-07-13T12:00:00Z',
        'error', 'Commerce lookup unavailable'
      )
    )
  $$,
  'the tenant-derived write seam persists an unresolved question'
);

select extensions.results_eq(
  $$
    select jsonb_build_object(
      'user_id', pending.user_id,
      'message_id', pending.external_message_id,
      'parent_id', pending.external_parent_id,
      'listing_id', pending.external_listing_id,
      'buyer_id', pending.external_buyer_id,
      'body', pending.body,
      'window_from', pending.resolution_window_from,
      'cursor_at', pending.observed_cursor_at
    )
    from public.ebay_unresolved_questions pending
    where pending.external_message_id = 'unresolved-question-a'
  $$,
  $$
    values (jsonb_build_object(
      'user_id', 'message-tenant-a',
      'message_id', 'unresolved-question-a',
      'parent_id', 'unresolved-question-a',
      'listing_id', 'sandbox-item-a',
      'buyer_id', 'buyer-unresolved-a',
      'body', 'Does this include the case?',
      'window_from', '2026-07-12T12:00:00Z'::timestamptz,
      'cursor_at', '2026-07-13T12:00:00Z'::timestamptz
    ))
  $$,
  'the unresolved queue preserves exact Trading identity and cursor data'
);

select extensions.throws_ok(
  $$
    insert into public.ebay_unresolved_questions (
      user_id, external_message_id, external_parent_id, external_listing_id,
      external_buyer_id, body, external_created_at, resolution_window_from,
      observed_cursor_at, last_resolution_attempted_at, last_error
    ) values (
      'message-tenant-b', 'spoofed-question', 'spoofed-question',
      'sandbox-item-b', 'buyer-b', 'Spoofed', '2026-07-13T12:00:00Z',
      '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z',
      '2026-07-13T12:00:00Z', 'spoofed'
    )
  $$,
  '42501',
  null,
  'tenant A cannot persist an unresolved question for tenant B'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'upsert_unresolved_question',
      jsonb_build_object(
        'external_message_id', 'unresolved-question-a',
        'external_parent_id', 'unresolved-question-a',
        'external_listing_id', 'sandbox-item-a',
        'external_buyer_id', 'buyer-unresolved-a',
        'body', 'Does this include the case?',
        'subject', 'Case question',
        'external_created_at', '2026-07-13T11:59:00Z',
        'resolution_window_from', '2026-07-12T12:00:00Z',
        'observed_cursor_at', '2026-07-13T12:00:00Z',
        'attempted_at', '2026-07-13T12:05:00Z',
        'error', 'Commerce lookup still unavailable'
      )
    )
  $$,
  'reconciliation replay updates the pending identity'
);

select extensions.results_eq(
  $$
    select count(*)::integer, max(resolution_attempts)::integer
    from public.ebay_unresolved_questions
    where external_message_id = 'unresolved-question-a'
  $$,
  $$values (1, 2)$$,
  'reconciliation replay updates one idempotent pending identity'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'sync_mark_success',
      jsonb_build_object(
        'at', '2026-07-13T12:05:00Z',
        'pending_resolution_count', 1
      )
    )
  $$,
  'cursor advancement records partial sync state'
);

select extensions.results_eq(
  $$
    select state.cursor_at = '2026-07-13T12:05:00Z'::timestamptz,
           state.last_error
    from public.ebay_message_sync_state state
    where state.user_id = 'message-tenant-a'
  $$,
  $$values (true, '1 eBay question awaiting conversation resolution'::text)$$,
  'cursor advancement keeps truthful pending-resolution sync state'
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
  '23514',
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
    select pg_temp.apply_ebay_message_write(
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
    select pg_temp.apply_ebay_message_write(
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

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'claim_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000001',
        'body', 'Direct client reply',
        'at', '2026-07-13T12:11:00Z',
        'retry', true
      )
    )
  $$,
  'a stale canonical delivery lease can be reclaimed'
);

select extensions.results_eq(
  $$
    with ignored as materialized (
      select pg_temp.apply_ebay_message_write(
        'fail_canonical',
        jsonb_build_object(
          'message_id', '93000000-0000-4000-8000-000000000001',
          'kind', 'ambiguous',
          'attempted_at', '2026-07-13T12:05:00Z'
        )
      )
    )
    select message.delivery_status,
           message.delivery_attempted_at = '2026-07-13T12:11:00Z'::timestamptz
    from public.messages message
    cross join ignored
    where message.id = '93000000-0000-4000-8000-000000000001'
  $$,
  $$values ('sending'::text, true)$$,
  'a late canonical failure cannot overwrite a reclaimed attempt'
);

select extensions.throws_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'complete_canonical',
      jsonb_build_object(
        'message_id', '93000000-0000-4000-8000-000000000001',
        'body', 'Direct client reply',
        'external_delivery_id', 'stale-delivery',
        'delivered_at', '2026-07-13T12:12:00Z',
        'attempted_at', '2026-07-13T12:05:00Z'
      )
    )
  $$,
  'P0002',
  'Reply delivery claim was lost',
  'a late canonical completion cannot finalize a reclaimed attempt'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where reply_to = '93000000-0000-4000-8000-000000000001'
      and direction = 'outbound'
  ),
  0,
  'a stale canonical completion creates no outbound delivery row'
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
    select pg_temp.apply_ebay_message_write(
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
    select pg_temp.apply_ebay_message_write(
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
    select pg_temp.apply_scheduled_ebay_message_write(
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
    select pg_temp.apply_scheduled_ebay_message_write(
      'message-tenant-b',
      'sync_mark_attempt',
      '{"at":"2026-07-13T12:05:00Z"}'::jsonb
    )
  $$,
  'the scheduler can advance a selected seller sync lifecycle'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_scheduled_ebay_message_write(
      'message-tenant-b',
      'upsert_unresolved_question',
      jsonb_build_object(
        'external_message_id', 'unresolved-question-b',
        'external_parent_id', 'unresolved-question-b',
        'external_listing_id', 'sandbox-item-b',
        'external_buyer_id', 'buyer-unresolved-b',
        'body', 'Is pickup available?',
        'external_created_at', '2026-07-13T12:01:00Z',
        'resolution_window_from', '2026-07-12T12:05:00Z',
        'observed_cursor_at', '2026-07-13T12:05:00Z',
        'attempted_at', '2026-07-13T12:05:00Z',
        'error', 'Commerce lookup unavailable'
      )
    )
  $$,
  'the constrained scheduler seam can queue one selected seller question'
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
      reply_kind, marketplace, delivery_request_id, delivery_status,
      external_delivery_id
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
      'delivered',
      'ebay-acknowledgement-a'
    )
  $$,
  'the trusted server can persist a delivered eBay reply'
);

set local role authenticated;

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'create_followup',
      jsonb_build_object(
        'root_id', '93000000-0000-4000-8000-000000000001',
        'body', 'One more detail',
        'request_id', 'followup-race',
        'at', '2026-07-13T12:00:00Z'
      )
    )
  $$,
  'a follow-up delivery intent is created for race testing'
);

select extensions.lives_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'claim_followup',
      jsonb_build_object(
        'message_id', (
          select id from public.messages
          where delivery_request_id = 'followup-race'
        ),
        'at', '2026-07-13T12:06:00Z'
      )
    )
  $$,
  'a stale follow-up delivery lease can be reclaimed'
);

select extensions.results_eq(
  $$
    with ignored as materialized (
      select pg_temp.apply_ebay_message_write(
        'fail_followup',
        jsonb_build_object(
          'message_id', (
            select id from public.messages
            where delivery_request_id = 'followup-race'
          ),
          'kind', 'ambiguous',
          'attempted_at', '2026-07-13T12:00:00Z'
        )
      )
    )
    select message.delivery_status,
           message.delivery_attempted_at = '2026-07-13T12:06:00Z'::timestamptz
    from public.messages message
    cross join ignored
    where message.delivery_request_id = 'followup-race'
  $$,
  $$values ('sending'::text, true)$$,
  'a late follow-up failure cannot overwrite a reclaimed attempt'
);

select extensions.throws_ok(
  $$
    select pg_temp.apply_ebay_message_write(
      'complete_followup',
      jsonb_build_object(
        'message_id', (
          select id from public.messages
          where delivery_request_id = 'followup-race'
        ),
        'external_delivery_id', 'stale-followup-delivery',
        'delivered_at', '2026-07-13T12:07:00Z',
        'attempted_at', '2026-07-13T12:00:00Z'
      )
    )
  $$,
  'P0002',
  'Follow-up delivery claim was lost',
  'a late follow-up completion cannot finalize a reclaimed attempt'
);

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

reset role;

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

select extensions.lives_ok(
  $$
    select public.save_ebay_connection(
      'deletion-user-a',
      'deletion_seller_a',
      'v1.test-a',
      'v1.access-a',
      '2026-07-14T12:00:00Z',
      array['scope-a']::text[]
    )
  $$,
  'a valid tenant-bound OAuth callback persists seller credentials'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-b","role":"authenticated"}',
  true
);

select extensions.lives_ok(
  $$
    select public.save_ebay_connection(
      'buyer-delete-shared',
      'deletion_seller_b',
      'v1.test-b',
      'v1.access-b',
      '2026-07-14T12:00:00Z',
      array['scope-b']::text[]
    )
  $$,
  'another tenant can persist its own non-erased OAuth grant'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-without-identity","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.save_ebay_connection(
      null,
      null,
      'v1.unmappable-refresh',
      'v1.unmappable-access',
      '2026-07-14T12:00:00Z',
      array['scope-a']::text[]
    )
  $$,
  '22023',
  'An eBay seller identity is required',
  'an unmappable OAuth grant cannot persist account-linked data'
);

reset role;

select extensions.ok(
  not exists (
    select 1
    from private.ebay_seller_identity_tenants seller_identity
    where to_jsonb(seller_identity)::text ilike '%deletion-user-a%'
       or to_jsonb(seller_identity)::text ilike '%deletion_seller_a%'
  ),
  'seller deletion mappings retain no raw provider identity'
);

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, marketplace,
  external_message_id, external_parent_id, external_conversation_id,
  external_listing_id, external_buyer_id
)
values
  (
    '93000000-0000-4000-8000-000000000011',
    'message-tenant-a',
    '91000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    'inbound',
    'Buyer deletion question A',
    'drafted',
    'ebay',
    'buyer-deletion-question-a',
    'buyer-deletion-question-a',
    'buyer-deletion-conversation-a',
    'sandbox-item-a',
    'buyer-delete-shared'
  ),
  (
    '93000000-0000-4000-8000-000000000012',
    'message-tenant-a',
    '91000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    'outbound',
    'Buyer deletion reply A',
    'approved',
    'ebay',
    null,
    'buyer-deletion-question-a',
    'buyer-deletion-conversation-a',
    'sandbox-item-a',
    'buyer-delete-shared'
  ),
  (
    '93000000-0000-4000-8000-000000000013',
    'message-tenant-b',
    '91000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000002',
    'inbound',
    'Buyer deletion question B',
    'drafted',
    'ebay',
    'buyer-deletion-question-b',
    'buyer-deletion-question-b',
    'buyer-deletion-conversation-b',
    'sandbox-item-b',
    'buyer-delete-shared'
  );

update public.messages
set reply_to = '93000000-0000-4000-8000-000000000011',
    reply_kind = 'followup',
    delivery_request_id = 'buyer-deletion-followup-a',
    delivery_status = 'failed'
where id = '93000000-0000-4000-8000-000000000012';

insert into public.ebay_unresolved_questions (
  user_id, external_message_id, external_parent_id, external_listing_id,
  external_buyer_id, resolution_window_from, observed_cursor_at,
  last_resolution_attempted_at, last_error
)
values
  (
    'message-tenant-a', 'buyer-deletion-pending-a',
    'buyer-deletion-pending-a', 'sandbox-item-a', 'buyer-delete-shared',
    '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z',
    '2026-07-13T12:00:00Z', 'retry later'
  ),
  (
    'message-tenant-b', 'buyer-deletion-pending-b',
    'buyer-deletion-pending-b', 'sandbox-item-b', 'buyer-delete-shared',
    '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z',
    '2026-07-13T12:00:00Z', 'retry later'
  );

insert into public.notifications (
  user_id, kind, title, source_message_id
)
values
  (
    'message-tenant-a', 'buyer_message', 'Buyer deletion notice A',
    '93000000-0000-4000-8000-000000000011'
  ),
  (
    'message-tenant-b', 'buyer_message', 'Buyer deletion notice B',
    '93000000-0000-4000-8000-000000000013'
  );

create temporary table ebay_generation_fixture (
  user_id text primary key,
  generation uuid not null
) on commit drop;
grant select, insert on ebay_generation_fixture to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into ebay_generation_fixture (user_id, generation)
select user_id, public.begin_scheduled_ebay_message_write(user_id)
from (values ('message-tenant-a'), ('message-tenant-b')) tenants(user_id);

select extensions.is(
  public.erase_ebay_user_data(null, 'buyer-delete-shared'),
  2,
  'buyer-only deletion erases every matched tenant without a seller connection match'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where id in (
      '93000000-0000-4000-8000-000000000011',
      '93000000-0000-4000-8000-000000000012',
      '93000000-0000-4000-8000-000000000013'
    )
  ),
  0,
  'buyer-only deletion removes matched threads and outbound descendants'
);

select extensions.is(
  (
    select count(*)::integer
    from public.ebay_unresolved_questions
    where external_buyer_id = 'buyer-delete-shared'
  ),
  0,
  'buyer-only deletion removes matched unresolved questions'
);

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where source_message_id in (
      '93000000-0000-4000-8000-000000000011',
      '93000000-0000-4000-8000-000000000013'
    )
  ),
  0,
  'buyer-only deletion removes notifications for matched threads'
);

select extensions.is(
  (
    select count(*)::integer
    from public.ebay_message_sync_state
    where user_id in ('message-tenant-a', 'message-tenant-b')
  ),
  0,
  'buyer-only deletion clears affected seller sync state'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where id in (
      '93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000002'
    )
  ),
  2,
  'buyer-only deletion preserves unrelated eBay threads in affected tenants'
);

select extensions.is(
  (select count(*)::integer from public.ebay_connections),
  2,
  'buyer username deletion preserves a seller whose user ID has the same value'
);

reset role;

select extensions.ok(
  not exists (
    select 1
    from private.ebay_erased_identity_tombstones tombstone
    where to_jsonb(tombstone)::text ilike '%buyer-delete-shared%'
  ),
  'buyer tombstones retain no raw deleted identity'
);

select extensions.ok(
  not exists (
    select 1
    from private.ebay_erased_identity_tombstones tombstone
    where tombstone.identity_hash = encode(
      extensions.digest('sender_id:buyer-delete-shared', 'sha256'),
      'hex'
    )
  ),
  'buyer tombstones use keyed hashes rather than dictionary-checkable digests'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.throws_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
      'message-tenant-a',
      'sync_mark_attempt',
      jsonb_build_object('at', '2026-07-13T12:10:00Z'),
      (
        select generation from ebay_generation_fixture
        where user_id = 'message-tenant-a'
      )
    )
  $$,
  '40001',
  'eBay messaging account generation expired',
  'a write generation acquired before erasure cannot recreate sync state'
);

select extensions.throws_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
      'message-tenant-a',
      'upsert_unresolved_question',
      jsonb_build_object(
        'external_message_id', 'buyer-deletion-replay',
        'external_parent_id', 'buyer-deletion-replay',
        'external_listing_id', 'sandbox-item-a',
        'external_buyer_id', 'buyer-delete-shared',
        'resolution_window_from', '2026-07-12T12:00:00Z',
        'observed_cursor_at', '2026-07-13T12:10:00Z',
        'attempted_at', '2026-07-13T12:10:00Z'
      ),
      public.begin_scheduled_ebay_message_write('message-tenant-a')
    )
  $$,
  '42501',
  'eBay identity has been erased',
  'a fresh sync cannot recreate a tombstoned buyer identity'
);

select extensions.lives_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
      'message-tenant-a',
      'upsert_unresolved_question',
      jsonb_build_object(
        'external_message_id', 'unrelated-buyer-after-deletion',
        'external_parent_id', 'unrelated-buyer-after-deletion',
        'external_listing_id', 'sandbox-item-a',
        'external_buyer_id', 'unrelated-buyer',
        'resolution_window_from', '2026-07-12T12:00:00Z',
        'observed_cursor_at', '2026-07-13T12:10:00Z',
        'attempted_at', '2026-07-13T12:10:00Z'
      ),
      public.begin_scheduled_ebay_message_write('message-tenant-a')
    )
  $$,
  'fresh generations preserve unrelated buyer synchronization'
);

select extensions.is(
  public.erase_ebay_user_data(null, 'buyer-delete-shared'),
  0,
  'buyer-only deletion is idempotent after matched data is erased'
);

reset role;

insert into public.ebay_unresolved_questions (
  user_id, external_message_id, external_parent_id, external_listing_id,
  resolution_window_from, observed_cursor_at, last_resolution_attempted_at,
  last_error
)
values (
  'message-tenant-a', 'deletion-pending-a', 'deletion-pending-a',
  'sandbox-item-a', '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z',
  '2026-07-13T12:00:00Z', 'retry later'
);

insert into public.notifications (
  user_id, kind, title, source_message_id
)
values (
  'message-tenant-a', 'buyer_message', 'Deletion notice question',
  '93000000-0000-4000-8000-000000000001'
)
on conflict (user_id, source_message_id) do update set title = excluded.title;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-a","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.erase_ebay_user_data('deletion-user-b', 'deletion_seller_b')
  $$,
  '42501',
  null,
  'an authenticated tenant cannot invoke account-deletion erasure'
);

delete from public.ebay_connections
where user_id = 'message-tenant-a';

select extensions.is(
  (select count(*)::integer from public.ebay_connections where user_id = 'message-tenant-a'),
  0,
  'disconnect removes live seller identity while preserving deletion discovery'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  public.erase_ebay_user_data('deletion-user-a', 'deletion_seller_a'),
  1,
  'service-only account deletion erases one matched connection transactionally'
);

select extensions.is(
  (select count(*)::integer from public.ebay_connections where user_id = 'message-tenant-a'),
  0,
  'account deletion removes the matched connection and encrypted tokens'
);

select extensions.is(
  (select count(*)::integer from public.messages where user_id = 'message-tenant-a' and marketplace = 'ebay'),
  0,
  'account deletion removes the tenant eBay message tree'
);

select extensions.is(
  (select count(*)::integer from public.ebay_unresolved_questions where user_id = 'message-tenant-a'),
  0,
  'account deletion removes unresolved eBay questions'
);

select extensions.is(
  (select count(*)::integer from public.ebay_message_sync_state where user_id = 'message-tenant-a'),
  0,
  'account deletion removes eBay seller sync state'
);

select extensions.is(
  (select count(*)::integer from public.notifications where user_id = 'message-tenant-a' and source_message_id is not null),
  0,
  'account deletion removes notifications sourced from eBay messages'
);

select extensions.ok(
  exists (
    select 1 from public.messages
    where user_id = 'message-tenant-a' and marketplace = 'simulated'
  ),
  'account deletion preserves unrelated simulated messages'
);

select extensions.ok(
  exists (
    select 1 from public.messages
    where user_id = 'message-tenant-b' and marketplace = 'ebay'
  ),
  'account deletion preserves another tenant eBay messages'
);

select extensions.is(
  (select count(*)::integer from public.ebay_connections where user_id = 'message-tenant-b'),
  1,
  'account deletion preserves another tenant connection'
);

select extensions.throws_ok(
  $$
    select public.begin_scheduled_ebay_message_write('message-tenant-a')
  $$,
  '42501',
  'eBay seller account has been erased',
  'a deleted seller tenant cannot restart messaging through fallback credentials'
);

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

select extensions.throws_ok(
  $$
    select public.save_ebay_connection(
      'deletion-user-a',
      'deletion_seller_a',
      'v1.stale-refresh',
      'v1.stale-access',
      '2026-07-14T13:00:00Z',
      array['scope-a']::text[]
    )
  $$,
  '42501',
  'eBay seller account has been erased',
  'an OAuth grant acquired before erasure cannot recreate deleted credentials'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-b","role":"authenticated"}',
  true
);

select extensions.lives_ok(
  $$
    select public.save_ebay_connection(
      'buyer-delete-shared',
      'deletion_seller_b',
      'v1.updated-b',
      'v1.updated-access-b',
      '2026-07-14T13:00:00Z',
      array['scope-b']::text[]
    )
  $$,
  'erasure serialization preserves valid callbacks for another tenant'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  public.erase_ebay_user_data('deletion-user-a', 'deletion_seller_a'),
  0,
  'account deletion is idempotent after all matched data is erased'
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ebay_connections'
      and cmd in ('INSERT', 'UPDATE')
  ),
  0,
  'authenticated clients have no direct connection insert or update policy'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"direct-policy-tenant","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    insert into public.ebay_connections (
      user_id, refresh_token_enc, account_generation
    ) values (
      'direct-policy-tenant',
      'v1.copied-ciphertext',
      gen_random_uuid()
    )
  $$,
  '42501',
  null,
  'an authenticated browser cannot directly create its own connection row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-b","role":"authenticated"}',
  true
);

update public.ebay_connections
set scopes = array['forged-browser-scope']::text[]
where user_id = 'message-tenant-b';

reset role;

select extensions.is(
  (
    select scopes
    from public.ebay_connections
    where user_id = 'message-tenant-b'
  ),
  array['scope-b']::text[],
  'an authenticated browser cannot directly mutate its connection row'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"message-tenant-b","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select extensions.lives_ok(
  $$
    select public.update_ebay_access_token_cache(
      (
        select account_generation
        from public.ebay_connections
        where user_id = 'message-tenant-b'
      ),
      'v1.rpc-cached-access',
      '2026-07-14T15:00:00Z'
    )
  $$,
  'the tenant-derived RPC can update only the current access-token cache'
);

reset role;

select extensions.is(
  (
    select access_token_enc
    from public.ebay_connections
    where user_id = 'message-tenant-b'
  ),
  'v1.rpc-cached-access',
  'the constrained cache RPC persists the refreshed ciphertext'
);

select private.lock_ebay_messaging_account('unmappable-legacy-tenant');

insert into public.ebay_connections (
  user_id,
  refresh_token_enc,
  access_token_enc,
  account_generation
)
select 'unmappable-legacy-tenant',
       'v1.legacy-refresh',
       'v1.legacy-access',
       account.generation
from private.ebay_messaging_account_generations account
where account.user_id = 'unmappable-legacy-tenant';

insert into public.messages (
  id, user_id, direction, body, status, marketplace,
  external_message_id, external_parent_id
) values (
  '96000000-0000-4000-8000-000000000001',
  'unmappable-legacy-tenant',
  'inbound',
  'Legacy undeletable question',
  'drafted',
  'ebay',
  'legacy-unmappable-question',
  'legacy-unmappable-question'
), (
  '96000000-0000-4000-8000-000000000002',
  'unmappable-legacy-tenant',
  'inbound',
  'Unrelated simulated message',
  'new',
  'simulated',
  null,
  null
);

insert into public.ebay_unresolved_questions (
  user_id, external_message_id, external_parent_id, external_listing_id,
  resolution_window_from, observed_cursor_at, last_resolution_attempted_at,
  last_error
) values (
  'unmappable-legacy-tenant',
  'legacy-unresolved',
  'legacy-unresolved',
  'legacy-listing',
  '2026-07-13T12:00:00Z',
  '2026-07-14T12:00:00Z',
  '2026-07-14T12:00:00Z',
  'legacy identity unavailable'
);

insert into public.ebay_message_sync_state (user_id, cursor_at)
values ('unmappable-legacy-tenant', '2026-07-14T12:00:00Z');

insert into public.notifications (
  user_id, kind, title, source_message_id
) values (
  'unmappable-legacy-tenant',
  'buyer_message',
  'Legacy question',
  '96000000-0000-4000-8000-000000000001'
);

select extensions.is(
  private.quarantine_unmappable_ebay_connections(),
  1,
  'legacy grants without a verified seller identity are quarantined'
);

select extensions.is(
  (
    select count(*)::integer
    from public.ebay_connections
    where user_id = 'unmappable-legacy-tenant'
  ),
  0,
  'quarantine removes unmappable encrypted credentials'
);

select extensions.is(
  (
    select
      (select count(*) from public.messages
       where user_id = 'unmappable-legacy-tenant' and marketplace = 'ebay')
      + (select count(*) from public.ebay_unresolved_questions
         where user_id = 'unmappable-legacy-tenant')
      + (select count(*) from public.ebay_message_sync_state
         where user_id = 'unmappable-legacy-tenant')
  )::integer,
  0,
  'quarantine removes transactional eBay messaging state'
);

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where user_id = 'unmappable-legacy-tenant'
      and source_message_id = '96000000-0000-4000-8000-000000000001'
  ),
  0,
  'quarantine removes notifications sourced from eBay messages'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where id = '96000000-0000-4000-8000-000000000002'
      and marketplace = 'simulated'
  ),
  1,
  'quarantine preserves unrelated simulated messages'
);

insert into public.items (id, user_id, attributes)
values (
  '97000000-0000-4000-8000-000000000001',
  'generation-tenant',
  '{}'
);

insert into public.listings (
  id, user_id, item_id, platform, title, status, ebay_listing_id, ebay_status
) values (
  '98000000-0000-4000-8000-000000000001',
  'generation-tenant',
  '97000000-0000-4000-8000-000000000001',
  'ebay',
  'Generation-bound listing',
  'published',
  'generation-listing',
  'published'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select public.save_ebay_connection(
  'generation-account-a',
  'generation_seller_a',
  'v1.generation-a-refresh',
  'v1.generation-a-access',
  '2026-07-14T15:00:00Z',
  array['scope-a']::text[]
);

reset role;

create temporary table ebay_account_generation_fixture (
  account_name text primary key,
  account_generation uuid not null
) on commit drop;

grant select on ebay_account_generation_fixture to service_role;

insert into ebay_account_generation_fixture
select 'account-a', account_generation
from public.ebay_connections
where user_id = 'generation-tenant';

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, marketplace,
  external_message_id, external_parent_id, external_listing_id,
  external_created_at
) values (
  '99000000-0000-4000-8000-000000000001',
  'generation-tenant',
  '97000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  'inbound',
  'Account A question',
  'drafted',
  'ebay',
  'generation-question-a',
  'generation-question-a',
  'generation-listing',
  '2026-07-14T14:00:00Z'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select public.save_ebay_connection(
  'generation-account-b',
  'generation_seller_a',
  'v1.generation-b-refresh',
  'v1.generation-b-access',
  '2026-07-14T16:00:00Z',
  array['scope-b']::text[]
);

reset role;

insert into ebay_account_generation_fixture
select 'account-b', account_generation
from public.ebay_connections
where user_id = 'generation-tenant';

select extensions.isnt(
  (select account_generation from ebay_account_generation_fixture where account_name = 'account-a'),
  (select account_generation from ebay_account_generation_fixture where account_name = 'account-b'),
  'reconnecting a replacement seller account creates a distinct account generation'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.throws_ok(
  format(
    $$select public.update_scheduled_ebay_access_token_cache(
      'generation-tenant', %L::uuid, 'v1.stale-account-a-access',
      '2026-07-14T17:00:00Z'
    )$$,
    (select account_generation::text
     from ebay_account_generation_fixture
     where account_name = 'account-a')
  ),
  '40001',
  'eBay connection generation expired',
  'an account A refresh cannot overwrite the replacement account B cache'
);

select extensions.lives_ok(
  format(
    $$select public.update_scheduled_ebay_access_token_cache(
      'generation-tenant', %L::uuid, 'v1.current-account-b-access',
      '2026-07-14T17:00:00Z'
    )$$,
    (select account_generation::text
     from ebay_account_generation_fixture
     where account_name = 'account-b')
  ),
  'the current account generation can cache a refreshed access token'
);

reset role;

select extensions.is(
  (select access_token_enc from public.ebay_connections
   where user_id = 'generation-tenant'),
  'v1.current-account-b-access',
  'only the current account token reaches the connection row'
);

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, marketplace,
  external_message_id, external_parent_id, external_listing_id, external_buyer_id,
  external_created_at
) values (
  '99000000-0000-4000-8000-000000000002',
  'generation-tenant',
  '97000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  'inbound',
  'Account B question',
  'new',
  'ebay',
  'generation-question-b',
  'generation-question-b',
  'generation-listing',
  'generation_seller_a',
  '2026-07-14T15:00:00Z'
);

delete from private.ebay_seller_identity_tenants seller_identity
where seller_identity.user_id = 'generation-tenant'
  and seller_identity.account_generation = (
    select account_generation
    from ebay_account_generation_fixture
    where account_name = 'account-a'
  )
  and seller_identity.identity_kind = 'user_id';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  public.erase_ebay_user_data('generation-account-a', 'generation_seller_a'),
  1,
  'a historical seller deletion targets its matched account generation'
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where id = '99000000-0000-4000-8000-000000000001'
  ),
  0,
  'historical account deletion removes only account A messaging state'
);

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where id = '99000000-0000-4000-8000-000000000002'
  ),
  1,
  'stable account A deletion preserves account B buyer data sharing its username'
);

select extensions.results_eq(
  $$
    select connection.ebay_user_id, account.seller_erased
    from public.ebay_connections connection
    join private.ebay_messaging_account_generations account
      on account.user_id = connection.user_id
      and account.generation = connection.account_generation
    where connection.user_id = 'generation-tenant'
  $$,
  $$values ('generation-account-b'::text, false)$$,
  'historical account deletion preserves account B credentials and current generation'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select extensions.lives_ok(
  $$
    select public.save_ebay_connection(
      'generation-account-b',
      'generation_seller_a',
      'v1.generation-b-refresh-2',
      'v1.generation-b-access-2',
      '2026-07-14T18:00:00Z',
      array['scope-b']::text[]
    )
  $$,
  'deleting stable account A does not tombstone replacement B shared username'
);

reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  public.read_scheduled_ebay_inbox(
    'generation-tenant',
    'active_listing',
    '{"external_listing_id":"sandbox-item-b","user_id":"message-tenant-b"}'
  ),
  null::jsonb,
  'scheduler listing reads cannot be redirected to another tenant by payload filters'
);

select extensions.ok(
  exists (
    select 1
    from public.list_scheduled_ebay_connection_user_ids()
    where user_id = 'generation-tenant'
  ),
  'the scheduler connection-list RPC returns the current connected tenant'
);

select extensions.is(
  public.read_scheduled_ebay_connection('generation-tenant')->>'ebay_user_id',
  'generation-account-b',
  'the scheduler connection RPC returns only the selected current account'
);

select public.apply_scheduled_ebay_message_write(
  'generation-tenant',
  'sync_mark_success',
  jsonb_build_object(
    'at', '2026-07-14T16:05:00Z',
    'pending_resolution_count', 0
  ),
  public.begin_scheduled_ebay_message_write('generation-tenant')
);

select extensions.is(
  public.read_scheduled_ebay_inbox(
    'generation-tenant',
    'cursor',
    '{"user_id":"message-tenant-b"}'::jsonb
  )->>'cursor_at',
  '2026-07-14T16:05:00+00:00',
  'scheduler cursor reads stay pinned to the selected account generation'
);

select extensions.is(
  jsonb_array_length(public.read_scheduled_ebay_inbox(
    'generation-tenant',
    'actionable_questions',
    '{"user_id":"message-tenant-b"}'::jsonb
  )),
  1,
  'scheduler message reads expose only current-generation actionable questions'
);

select extensions.is(
  jsonb_array_length(public.read_scheduled_ebay_inbox(
    'generation-tenant',
    'draft_candidates',
    '{"stale_before":"2026-07-14T16:05:00Z","user_id":"message-tenant-b"}'::jsonb
  )),
  1,
  'scheduler draft reads join only the selected tenant messages items and listings'
);

select extensions.ok(
  public.begin_scheduled_ebay_message_write('fresh-operator-tenant') is not null,
  'the scheduler initializes a fresh operator messaging generation before reads'
);

select extensions.is(
  public.read_scheduled_ebay_inbox(
    'fresh-operator-tenant',
    'cursor',
    '{}'::jsonb
  ),
  null::jsonb,
  'a fresh operator generation can perform its first scheduled cursor read'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.read_scheduled_ebay_inbox(
      'generation-tenant',
      'cursor',
      '{}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function read_scheduled_ebay_inbox',
  'an authenticated tenant cannot invoke scheduler read authority'
);

reset role;

update public.messages
set status = 'drafted',
    draft_reply = 'Canonical dispatch in flight'
where id = '99000000-0000-4000-8000-000000000002';

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, marketplace,
  external_message_id, external_parent_id, external_conversation_id,
  external_listing_id, external_buyer_id, external_created_at
) values (
  '99000000-0000-4000-8000-000000000003',
  'generation-tenant',
  '97000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  'inbound',
  'Follow-up root',
  'sent',
  'ebay',
  'generation-question-followup',
  'generation-question-followup',
  'generation-conversation-followup',
  'generation-listing',
  'generation-buyer',
  '2026-07-14T15:30:00Z'
);

insert into public.messages (
  id, user_id, item_id, listing_id, direction, body, status, sent_at,
  reply_to, reply_kind, marketplace, external_parent_id,
  external_conversation_id, external_listing_id, external_buyer_id,
  delivery_status, external_delivery_id, delivery_attempted_at
) values (
  '99000000-0000-4000-8000-000000000004',
  'generation-tenant',
  '97000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  'outbound',
  'Delivered root reply',
  'sent',
  '2026-07-14T15:35:00Z',
  '99000000-0000-4000-8000-000000000003',
  'reply',
  'ebay',
  'generation-question-followup',
  'generation-conversation-followup',
  'generation-listing',
  'generation-buyer',
  'delivered',
  'generation-delivery-root',
  '2026-07-14T15:35:00Z'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select pg_temp.apply_ebay_message_write(
  'claim_canonical',
  '{"message_id":"99000000-0000-4000-8000-000000000002","body":"Canonical dispatch in flight","at":"2026-07-14T16:10:00Z","retry":false}'::jsonb
);

select pg_temp.apply_ebay_message_write(
  'begin_provider_dispatch',
  '{"message_id":"99000000-0000-4000-8000-000000000002","attempted_at":"2026-07-14T16:10:00Z"}'::jsonb
);

create temporary table ebay_followup_dispatch_fixture on commit drop as
select (pg_temp.apply_ebay_message_write(
  'create_followup',
  '{"root_id":"99000000-0000-4000-8000-000000000003","body":"Follow-up dispatch in flight","request_id":"generation-followup-dispatch","at":"2026-07-14T16:10:00Z"}'::jsonb
)->'message'->>'id')::uuid as message_id;

select pg_temp.apply_ebay_message_write(
  'begin_provider_dispatch',
  jsonb_build_object(
    'message_id', (select message_id from ebay_followup_dispatch_fixture),
    'attempted_at', '2026-07-14T16:10:00Z'
  )
);

reset role;

select extensions.is(
  (select count(*)::integer from private.ebay_provider_dispatch_leases
   where user_id = 'generation-tenant'),
  2,
  'canonical and follow-up provider writes hold generation-bound dispatch leases'
);

update private.ebay_provider_dispatch_leases
set expires_at = statement_timestamp() + interval '5 seconds'
where user_id = 'generation-tenant';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select pg_temp.apply_ebay_message_write(
  'renew_provider_dispatch',
  '{"message_id":"99000000-0000-4000-8000-000000000002","attempted_at":"2026-07-14T16:10:00Z"}'::jsonb
);
select pg_temp.apply_ebay_message_write(
  'renew_provider_dispatch',
  jsonb_build_object(
    'message_id', (select message_id from ebay_followup_dispatch_fixture),
    'attempted_at', '2026-07-14T16:10:00Z'
  )
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from private.ebay_provider_dispatch_leases
    where user_id = 'generation-tenant'
      and expires_at > statement_timestamp() + interval '4 minutes'
  ),
  2,
  'canonical and follow-up workers renew their exact generation-bound dispatch leases'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.throws_ok(
  $$select public.erase_ebay_user_data(
    'generation-account-b', 'generation_seller_a'
  )$$,
  '40001',
  'eBay provider dispatch is active',
  'account erasure cannot acknowledge while provider dispatch is active'
);

reset role;

update private.ebay_provider_dispatch_leases
set expires_at = statement_timestamp() - interval '1 second'
where user_id = 'generation-tenant';
select private.expire_ebay_provider_dispatch_leases('generation-tenant');

select extensions.is(
  (
    select count(*)::integer
    from public.messages
    where user_id = 'generation-tenant'
      and delivery_status = 'ambiguous'
      and id in (
        '99000000-0000-4000-8000-000000000002',
        (select message_id from ebay_followup_dispatch_fixture)
      )
  ),
  2,
  'expired canonical and follow-up dispatches become delivery unconfirmed'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"generation-tenant","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);

select pg_temp.apply_ebay_message_write(
  'fail_canonical',
  '{"message_id":"99000000-0000-4000-8000-000000000002","kind":"ambiguous","attempted_at":"2026-07-14T16:10:00Z"}'::jsonb
);
select pg_temp.apply_ebay_message_write(
  'fail_followup',
  jsonb_build_object(
    'message_id', (select message_id from ebay_followup_dispatch_fixture),
    'kind', 'ambiguous',
    'attempted_at', '2026-07-14T16:10:00Z'
  )
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  public.erase_ebay_user_data('generation-account-b', 'generation_seller_a'),
  1,
  'erasure succeeds after both dispatches settle as delivery unconfirmed'
);

select * from extensions.finish();
rollback;
