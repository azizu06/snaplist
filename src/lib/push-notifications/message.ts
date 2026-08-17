import { safeSellerCoreValue, sellerCopyViolations } from "@/lib/seller-copy";

/**
 * What a seller push says (#891).
 *
 * Two moments, one sentence each. A push cannot be edited after it lands on a
 * lock screen, so the copy states only what SnapList has already durably
 * observed: an item finished and has a draft waiting, or eBay confirmed a
 * publish. It never carries a price, a buyer, or a sale, because none of those
 * are what either moment proves.
 */

export type SellerPushMoment = "listingReady" | "listingPublished";

export interface SellerPushEvent {
  moment: SellerPushMoment;
  /**
   * The item's generated name. Model output, so it is only used when it passes
   * the seller-copy contract unchanged; otherwise the unnamed sentence says the
   * same true thing.
   */
  itemName: string | null;
}

export interface SellerPushMessage {
  title: string;
  body: string;
}

const BODY: Record<SellerPushMoment, string> = {
  listingReady: "Open SnapList to check the details before you publish.",
  listingPublished: "Open SnapList to view or edit it.",
};

const UNNAMED_TITLE: Record<SellerPushMoment, string> = {
  listingReady: "Your listing is ready to review",
  listingPublished: "Your listing is live on eBay",
};

const NAMED_TITLE_SUFFIX: Record<SellerPushMoment, string> = {
  listingReady: "is ready to review",
  listingPublished: "is live on eBay",
};

/**
 * Claims neither moment establishes.
 *
 * A currency amount is matched by symbol or code rather than by digits, because
 * a real item name is full of digits that are not money ("WH-1000XM4", "Switch
 * OLED"). Matching digits alone would silently drop every named title.
 */
const PUSH_VIOLATION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "price-claim",
    pattern:
      /(?:[$£€¥]\s?\d|\d\s?(?:usd|eur|gbp|dollars?)\b|\b(?:price|priced|pricing|worth|value|valued)\b)/i,
  },
  {
    code: "sale-claim",
    pattern:
      /\b(?:sold|sale|sells|selling for|buyer|buyers|bought|purchased?|order|offer|bid)\b/i,
  },
];

/** Every rule the supplied push copy breaks, including the shared seller rules. */
export function sellerPushCopyViolations(message: SellerPushMessage): string[] {
  const text = `${message.title}\n${message.body}`;
  return [
    ...sellerCopyViolations(text),
    ...PUSH_VIOLATION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
      ({ code }) => code,
    ),
  ];
}

export function buildSellerPushMessage(
  event: SellerPushEvent,
): SellerPushMessage {
  const body = BODY[event.moment];
  const named = namedTitle(event);
  return named && sellerPushCopyViolations({ title: named, body }).length === 0
    ? { title: named, body }
    : { title: UNNAMED_TITLE[event.moment], body };
}

function namedTitle(event: SellerPushEvent): string | undefined {
  const name = safeSellerCoreValue(event.itemName ?? undefined);
  return name ? `${name} ${NAMED_TITLE_SUFFIX[event.moment]}` : undefined;
}
