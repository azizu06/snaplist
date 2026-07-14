# eBay pre-sale messaging: Sandbox operator runbook

This runbook verifies issue #133 with two disposable eBay Sandbox users. It is
operator-only: automated tests never call eBay, this procedure never targets
production, and no token or credential belongs in screenshots, logs, issues, or
commits.

## Selected provider contract

SnapList uses two authenticated eBay surfaces behind one marketplace-messaging
adapter:

- Trading API [`GetMemberMessages`](https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetMemberMessages.html)
  fetches active-listing questions with `MailMessageType=AskSellerQuestion`,
  inclusive creation-time bounds, and separate fully paginated
  `MessageStatus=Unanswered` and `MessageStatus=Answered` calls. This follows
  eBay's official [`AskSellerQuestion` workaround](https://developer.ebay.com/support/kb-article?KBid=1170);
  SnapList deduplicates overlap and treats answered evidence as authoritative.
- Trading API [`AddMemberMessageRTQ`](https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddMemberMessageRTQ.html)
  sends the seller-approved answer. Its `ParentMessageID` is the exact
  `MemberMessageExchange.Question.MessageID` returned by `GetMemberMessages`.
  It is not the mailbox/display `GetMyMessages.MessageID`; eBay documents that
  distinction on [`MyMessagesMessageType`](https://developer.ebay.com/devzone/xml/docs/Reference/eBay/types/MyMessagesMessageType.html).
- Commerce Message API [`getConversations`](https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversations)
  finds candidate conversations for the listing and buyer. SnapList then uses
  [`getConversation`](https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversation)
  with `conversation_type=FROM_MEMBERS` and follows its message pagination so
  an unanswered question need not be the conversation's latest message.
  Commerce Message API [`sendMessage`](https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/sendMessage)
  sends later seller-authored text into that existing conversation. SnapList
  persists this separate conversation ID; it never substitutes the Trading
  question ID.

The app enforces a common 2,000-character plain-text ceiling. The current
`AddMemberMessageRTQ` reference documents a 2,000-character body, no HTML, and
`DisplayToPublic`; the [`SendMessageRequest`](https://developer.ebay.com/api-docs/commerce/message/types/m2m%3ASendMessageRequest)
also documents a 2,000-character `messageText` maximum. The RTQ call has a
seller-level burst ceiling of 75 calls in 60 seconds and a 100-second block if
exceeded. Normal app rate limiting stays far below that ceiling. General daily
usage can be checked in eBay's official [API call limits](https://developer.ebay.com/develop/get-started/api-call-limits)
page and Developer Analytics API.

OAuth connections request both the traditional base scope and the Message API
scope:

```text
https://api.ebay.com/oauth/api_scope
https://api.ebay.com/oauth/api_scope/commerce.message
```

See eBay's official [traditional API OAuth guidance](https://developer.ebay.com/develop/guides-v2/authorization#using-oauth-with-the-ebay-traditional-apis).
An older connection that predates the Message API scope must reconnect before
this runbook.

Legacy encrypted grants that lack both a verified eBay user ID and username are
quarantined during migration together with their transactional messaging state.
The seller must reconnect before messaging can resume.

Attachments are deliberately excluded (#134). The RTQ reference requires an
image URL to be uploaded to eBay Picture Services by a separate call or web
flow, while Commerce `sendMessage` has its own hosted-media model. #133 sends
text only and never silently drops a selected attachment.

## Preconditions

1. Use a Sandbox keyset and two Sandbox users: `SELLER` and `BUYER`. eBay's RTQ
   test instructions explicitly require two test users. Sandbox and Production
   have separate keys, tokens, and data; see eBay's [environment guide](https://developer.ebay.com/api-docs/static/gs_understand-the-sandbox-and.html).
2. `SELLER` is connected in SnapList through the existing per-user OAuth flow
   with both messaging scopes above. Keep `EBAY_BASE_URL` set to
   `https://api.sandbox.ebay.com`. For the app-level Sandbox credential fallback,
   set `EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID` to this seller's Clerk user ID
   and `EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID` to that Sandbox seller's
   stable eBay user ID; the database binds both to one account generation;
   every other tenant is denied that shared credential, and production never
   permits the fallback. Connected sellers continue to use their own token provider.
3. `SELLER` has an active Sandbox listing that was published through SnapList,
   so its eBay ItemID is mapped to the same tenant's `listings` row.
4. `CRON_SECRET` is set only if the background entry point is being exercised.
   `vercel.json` schedules `/api/cron/inbox-sync` every five minutes. Opening
   the inbox also requests the same shared sync service immediately.

Do not change provider settings, deploy production credentials, or use a real
listing as part of this check. Production activation remains owner-controlled
under #17.

## Round trip

1. Sign in to Sandbox as `BUYER`, open the active test listing, and send one
   distinctive plain-text question. Record the approximate time and eBay
   ItemID, not any token.
2. Sign in to SnapList as the connected `SELLER` and open `/inbox`. The
   foreground refresh may ingest it immediately; otherwise wait only for the
   next configured five-minute cron boundary. Five minutes is a maximum normal
   target, never an intentional delay.
3. Verify exactly one conversation appears for the correct listing and tenant.
   Refresh/reconnect once to exercise the overlapping window. Verify no second
   message, draft, or notification appears.
4. Inspect only non-secret database fields if deeper evidence is needed:
   `marketplace=ebay`, the external eBay message/question ID, the separate
   Commerce conversation ID, listing ID, buyer/public user ID, and timestamps.
   Confirm the reply parent equals the imported Trading question ID.
5. Edit the generated reply if desired, approve it once, and verify the buyer's
   Sandbox inbox receives exactly that text. The SnapList row must become
   `delivered` only after an acknowledged eBay response.
6. Send one seller-authored text follow-up. Verify it is appended to the same
   eBay conversation and SnapList stores its returned Commerce message ID.

## Failure and replay checks

- Repeat foreground refresh and invoke the authorized cron once. The external
  question, local draft, notification, and external sends must remain singular.
- To exercise a deterministic local failure, use the offline mock tests. Do not
  sever a live request mid-flight merely to manufacture ambiguity.
- A rejected or failed write remains visible as **Not delivered**. An
  acknowledgement-less write is labeled **Delivery unconfirmed** and requires
  explicit duplicate-risk confirmation before retry. Both keep `sent_at` empty.
  Replaying
  the original browser request key does not dispatch again. An operator-driven
  retry is a new external attempt; an ambiguous prior attempt can never be
  claimed as certainly absent from eBay.
- A question for an eBay ItemID not mapped to that seller's active SnapList
  listing is skipped. A user from another SnapList tenant must receive no row
  and cannot read or send the first seller's conversation.

## Evidence to capture

Capture redacted timestamps, local row IDs, eBay ItemID, delivery states, and
the observed buyer/seller UI result. Never capture access/refresh tokens,
cookies, client secrets, encryption keys, or authorization headers. Record
whether the check was Sandbox-live or offline-only; absence of owner authority
must remain an explicit unverified item, not be presented as a successful live
round trip.

## Documentation caveat

The current `GetMemberMessages` reference contains contradictory field notes
for `AskSellerQuestion`. SnapList follows eBay's linked workaround by making
separate status-filtered calls and keeps an operator Sandbox check as the final
provider-behavior proof.
