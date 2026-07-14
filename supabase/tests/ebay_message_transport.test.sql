begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(69);

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
    select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'provider-unavailable-question-a'
    ),
    'expected_status', 'new'
  )
);

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'mark_provider_unavailable',
  jsonb_build_object(
    'external_message_id', 'provider-unavailable-new-question-a',
    'at', '2026-07-13T12:10:00Z'
  )
);

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'mark_provider_unavailable',
  jsonb_build_object(
    'external_message_id', 'provider-unavailable-question-a',
    'at', '2026-07-13T12:30:00Z'
  )
);

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'ambiguous-question-a'
    ),
    'expected_status', 'new'
  )
);

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'claim_draft',
  jsonb_build_object(
    'message_id', (
      select id from public.messages
      where external_message_id = 'active-send-question-a'
    ),
    'expected_status', 'new'
  )
);

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
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

select public.apply_ebay_message_write(
  'mark_externally_answered',
  jsonb_build_object(
    'external_message_id', 'active-send-question-a',
    'at', '2026-07-13T12:14:00Z'
  )
);

select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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

select extensions.lives_ok(
  $$
    select public.apply_ebay_message_write(
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
      select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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

select extensions.lives_ok(
  $$
    select public.apply_scheduled_ebay_message_write(
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
    select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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
      select public.apply_ebay_message_write(
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
    select public.apply_ebay_message_write(
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

insert into public.ebay_connections (
  user_id, ebay_user_id, ebay_username, refresh_token_enc
)
values
  ('message-tenant-a', 'deletion-user-a', 'deletion_seller_a', 'v1.test-a'),
  ('message-tenant-b', 'deletion-user-b', 'deletion_seller_b', 'v1.test-b');

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

select extensions.is(
  public.erase_ebay_user_data('deletion-user-a', 'deletion_seller_a'),
  0,
  'account deletion is idempotent after all matched data is erased'
);

select * from extensions.finish();
rollback;
