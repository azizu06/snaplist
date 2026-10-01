begin;
select plan(6);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Isolate only for this rolled-back transaction; no existing wake-up is lost.
update pgmq.q_included_offer_redemption set vt = clock_timestamp() + interval '1 hour';
create temp table claim_messages (position integer, message_id bigint);
insert into claim_messages
select 1, pgmq.send('included_offer_redemption', '{"claim_id":"00000000-0000-0000-0000-000000000001","schema_version":1}');
insert into claim_messages
select 2, pgmq.send('included_offer_redemption', '{"claim_id":"00000000-0000-0000-0000-000000000002","schema_version":1}');

select is(
  (select message_id from public.claim_included_offer_message(35)),
  (select message_id from claim_messages where position = 1),
  'the first never-read claim opens first'
);

-- Model the next minute tick: the abandoned head is visible again, but its
-- deferral is more recent than the waiting seller's original eligibility.
select public.defer_included_offer_message(
  (select message_id from claim_messages where position = 1), 0
);
select is(
  (select message_id from public.claim_included_offer_message(35)),
  (select message_id from claim_messages where position = 2),
  'a redelivered abandoned claim does not starve the next seller'
);
select is(
  (select count(*) from public.claim_included_offer_message(35)),
  1::bigint,
  'each invocation claims at most one message'
);
select throws_ok(
  $$select * from public.claim_included_offer_message(0)$$,
  '22023', 'Invalid included-offer queue claim bounds',
  'visibility bounds remain enforced'
);
select throws_ok(
  $$select * from public.claim_included_offer_message(null)$$,
  '22023', 'Invalid included-offer queue claim bounds',
  'a null visibility timeout cannot admit unfenced work'
);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select * from public.claim_included_offer_message(35)$$,
  '42501', 'Included-offer redemption authorization is required',
  'queue authority still refuses a seller identity'
);
select * from finish();
rollback;
