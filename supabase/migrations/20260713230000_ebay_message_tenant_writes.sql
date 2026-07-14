create or replace function public.apply_ebay_message_write(
  p_user_id text,
  p_operation text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(auth.jwt()->>'role', '');
  v_message public.messages%rowtype;
  v_root public.messages%rowtype;
  v_listing public.listings%rowtype;
  v_count integer := 0;
  v_inserted boolean := false;
  v_at timestamptz;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception using errcode = '22023', message = 'A seller tenant is required';
  end if;
  if v_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'Server authorization is required';
  end if;

  if p_operation = 'sync_mark_attempt' then
    insert into public.ebay_message_sync_state (user_id, last_attempted_at)
    values (p_user_id, (p_payload->>'at')::timestamptz)
    on conflict (user_id) do update
      set last_attempted_at = excluded.last_attempted_at;
    return 'null'::jsonb;
  elsif p_operation = 'sync_mark_success' then
    v_at := (p_payload->>'at')::timestamptz;
    insert into public.ebay_message_sync_state (
      user_id, cursor_at, last_succeeded_at, last_error
    ) values (p_user_id, v_at, v_at, null)
    on conflict (user_id) do update
      set cursor_at = excluded.cursor_at,
          last_succeeded_at = excluded.last_succeeded_at,
          last_error = null;
    return 'null'::jsonb;
  elsif p_operation = 'sync_mark_failure' then
    insert into public.ebay_message_sync_state (
      user_id, last_attempted_at, last_error
    ) values (
      p_user_id,
      (p_payload->>'at')::timestamptz,
      left(coalesce(p_payload->>'error', 'Inbox sync failed'), 500)
    )
    on conflict (user_id) do update
      set last_attempted_at = excluded.last_attempted_at,
          last_error = excluded.last_error;
    return 'null'::jsonb;
  elsif p_operation = 'import_question' then
    select listing.*
    into v_listing
    from public.listings listing
    where listing.id = (p_payload->>'listing_id')::uuid
      and listing.item_id = (p_payload->>'item_id')::uuid
      and listing.user_id = p_user_id
      and listing.platform = 'ebay'
      and listing.ebay_listing_id = p_payload->>'external_listing_id'
      and listing.ebay_status = 'published'
      and listing.status = 'published';
    if not found then
      raise exception using errcode = '42501', message = 'Active seller listing not found';
    end if;

    begin
      insert into public.messages as message (
        user_id, item_id, listing_id, direction, body, status, marketplace,
        external_message_id, external_parent_id, external_conversation_id,
        external_listing_id, external_buyer_id, external_created_at
      ) values (
        p_user_id,
        v_listing.item_id,
        v_listing.id,
        'inbound',
        p_payload->>'body',
        'new',
        'ebay',
        p_payload->>'external_message_id',
        p_payload->>'external_parent_id',
        p_payload->>'external_conversation_id',
        p_payload->>'external_listing_id',
        p_payload->>'external_buyer_id',
        (p_payload->>'external_created_at')::timestamptz
      )
      returning message.* into v_message;
      v_inserted := true;
    exception when unique_violation then
      select message.*
      into v_message
      from public.messages message
      where message.user_id = p_user_id
        and message.marketplace = 'ebay'
        and message.external_message_id = p_payload->>'external_message_id'
        and message.direction = 'inbound';
      if not found then
        raise;
      end if;
    end;
    return jsonb_build_object(
      'message', to_jsonb(v_message),
      'inserted', v_inserted
    );
  elsif p_operation = 'ensure_notification' then
    select message.*
    into v_message
    from public.messages message
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound';
    if not found then
      raise exception using errcode = '42501', message = 'Seller message not found';
    end if;
    select listing.*
    into v_listing
    from public.listings listing
    where listing.id = v_message.listing_id
      and listing.item_id = v_message.item_id
      and listing.user_id = p_user_id;
    if not found then
      raise exception using errcode = '42501', message = 'Seller listing not found';
    end if;
    insert into public.notifications (
      user_id, kind, title, body, href, item_id, listing_id, source_message_id
    ) values (
      p_user_id,
      'buyer_message',
      case
        when v_listing.title is null then 'New buyer question'
        else 'New question on “' || v_listing.title || '”'
      end,
      v_message.body,
      '/inbox?c=' || v_message.id::text,
      v_message.item_id,
      v_message.listing_id,
      v_message.id
    )
    on conflict (user_id, source_message_id) do nothing;
    return 'null'::jsonb;
  elsif p_operation = 'claim_draft' then
    update public.messages message
    set status = 'drafting'
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and (
        (
          p_payload->>'expected_status' = 'drafting'
          and message.status = 'drafting'
          and message.updated_at = (p_payload->>'expected_updated_at')::timestamptz
        )
        or (
          p_payload->>'expected_status' <> 'drafting'
          and message.status in ('new', 'draft_failed')
        )
      );
    get diagnostics v_count = row_count;
    return to_jsonb(v_count = 1);
  elsif p_operation = 'attach_draft' then
    update public.messages message
    set draft_reply = p_payload->>'draft_reply',
        draft_model = p_payload->>'draft_model',
        status = 'drafted'
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and message.status = 'drafting';
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception using errcode = 'P0002', message = 'Reply draft claim was lost';
    end if;
    return 'null'::jsonb;
  elsif p_operation = 'mark_draft_failed' then
    update public.messages message
    set status = 'draft_failed'
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and message.status = 'drafting';
    return 'null'::jsonb;
  elsif p_operation = 'claim_canonical' then
    v_at := (p_payload->>'at')::timestamptz;
    update public.messages message
    set status = 'sent',
        draft_reply = btrim(p_payload->>'body'),
        delivery_request_id = message.id::text,
        delivery_status = 'sending',
        delivery_attempted_at = v_at,
        delivery_error = null
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and (
        (
          coalesce((p_payload->>'retry')::boolean, false) = false
          and message.status = 'drafted'
        )
        or (
          coalesce((p_payload->>'retry')::boolean, false) = true
          and (
            message.delivery_status in ('rejected', 'failed', 'ambiguous')
            or (
              message.delivery_status = 'sending'
              and message.delivery_attempted_at < v_at - interval '5 minutes'
            )
          )
        )
      );
    get diagnostics v_count = row_count;
    return to_jsonb(v_count = 1);
  elsif p_operation = 'fail_canonical' then
    update public.messages message
    set delivery_status = p_payload->>'kind',
        delivery_error = p_payload->>'kind',
        sent_at = null
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and message.delivery_status = 'sending';
    return 'null'::jsonb;
  elsif p_operation = 'complete_canonical' then
    select message.*
    into v_root
    from public.messages message
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound'
      and message.delivery_status = 'sending'
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Reply delivery claim was lost';
    end if;
    begin
      insert into public.messages as message (
        user_id, item_id, listing_id, direction, body, status, sent_at,
        reply_to, reply_kind, marketplace, external_parent_id,
        external_conversation_id, external_listing_id, external_buyer_id,
        delivery_status, external_delivery_id, delivery_attempted_at
      ) values (
        p_user_id,
        v_root.item_id,
        v_root.listing_id,
        'outbound',
        btrim(p_payload->>'body'),
        'sent',
        (p_payload->>'delivered_at')::timestamptz,
        v_root.id,
        'reply',
        'ebay',
        v_root.external_parent_id,
        v_root.external_conversation_id,
        v_root.external_listing_id,
        v_root.external_buyer_id,
        'delivered',
        p_payload->>'external_delivery_id',
        (p_payload->>'delivered_at')::timestamptz
      )
      returning message.* into v_message;
    exception when unique_violation then
      select message.*
      into v_message
      from public.messages message
      where message.user_id = p_user_id
        and message.reply_to = v_root.id
        and message.direction = 'outbound'
        and (message.reply_kind is null or message.reply_kind = 'reply');
      if not found then
        raise;
      end if;
    end;
    update public.messages message
    set delivery_status = 'delivered',
        delivery_error = null,
        sent_at = (p_payload->>'delivered_at')::timestamptz
    where message.id = v_root.id
      and message.user_id = p_user_id;
    return to_jsonb(v_message);
  elsif p_operation = 'create_followup' then
    select message.*
    into v_root
    from public.messages message
    where message.id = (p_payload->>'root_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'inbound';
    if not found or not exists (
      select 1
      from public.messages reply
      where reply.user_id = p_user_id
        and reply.reply_to = v_root.id
        and reply.direction = 'outbound'
        and reply.delivery_status = 'delivered'
        and (reply.reply_kind is null or reply.reply_kind = 'reply')
    ) then
      raise exception using errcode = 'P0002', message = 'Delivered conversation not found';
    end if;
    begin
      insert into public.messages as message (
        user_id, item_id, listing_id, direction, body, status, reply_to,
        reply_kind, marketplace, external_parent_id, external_conversation_id,
        external_listing_id, external_buyer_id, delivery_request_id,
        delivery_status, delivery_attempted_at
      ) values (
        p_user_id,
        v_root.item_id,
        v_root.listing_id,
        'outbound',
        btrim(p_payload->>'body'),
        'approved',
        v_root.id,
        'followup',
        'ebay',
        v_root.external_parent_id,
        v_root.external_conversation_id,
        v_root.external_listing_id,
        v_root.external_buyer_id,
        p_payload->>'request_id',
        'sending',
        (p_payload->>'at')::timestamptz
      )
      returning message.* into v_message;
      v_inserted := true;
    exception when unique_violation then
      select message.*
      into v_message
      from public.messages message
      where message.user_id = p_user_id
        and message.delivery_request_id = p_payload->>'request_id';
      if not found then
        raise;
      end if;
    end;
    return jsonb_build_object(
      'message', to_jsonb(v_message),
      'inserted', v_inserted
    );
  elsif p_operation = 'claim_followup' then
    v_at := (p_payload->>'at')::timestamptz;
    update public.messages message
    set delivery_status = 'sending',
        delivery_attempted_at = v_at,
        delivery_error = null
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'outbound'
      and message.reply_kind = 'followup'
      and (
        message.delivery_status in ('rejected', 'failed', 'ambiguous')
        or (
          message.delivery_status = 'sending'
          and message.delivery_attempted_at < v_at - interval '5 minutes'
        )
      );
    get diagnostics v_count = row_count;
    return to_jsonb(v_count = 1);
  elsif p_operation = 'fail_followup' then
    update public.messages message
    set status = 'approved',
        delivery_status = p_payload->>'kind',
        delivery_error = p_payload->>'kind',
        sent_at = null
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'outbound'
      and message.reply_kind = 'followup'
      and message.delivery_status = 'sending';
    return 'null'::jsonb;
  elsif p_operation = 'complete_followup' then
    update public.messages message
    set status = 'sent',
        sent_at = (p_payload->>'delivered_at')::timestamptz,
        delivery_status = 'delivered',
        external_delivery_id = p_payload->>'external_delivery_id',
        delivery_error = null
    where message.id = (p_payload->>'message_id')::uuid
      and message.user_id = p_user_id
      and message.marketplace = 'ebay'
      and message.direction = 'outbound'
      and message.reply_kind = 'followup'
      and message.delivery_status = 'sending'
    returning message.* into v_message;
    if not found then
      raise exception using errcode = 'P0002', message = 'Follow-up delivery claim was lost';
    end if;
    return to_jsonb(v_message);
  end if;

  raise exception using errcode = '22023', message = 'Unsupported eBay message write operation';
end;
$$;

revoke all on function public.apply_ebay_message_write(text, text, jsonb) from public;
grant execute on function public.apply_ebay_message_write(text, text, jsonb)
  to service_role;
