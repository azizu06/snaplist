import { assertScrapingBeeProxyTemplate } from "./core";
import type {
  ProviderQueryCapture,
  ScrapingBeeCreditAccounting,
} from "./types";

const SCRAPINGBEE_USAGE_URL = "https://app.scrapingbee.com/api/v1/usage";

function apiKeyFromTemplate(template: string): string {
  const valid = assertScrapingBeeProxyTemplate(template);
  const parsed = new URL(
    valid.replace("{url}", encodeURIComponent("https://www.ebay.com/")),
  );
  const key = parsed.searchParams.get("api_key")?.trim();
  if (!key) {
    throw new Error("ScrapingBee usage accounting requires the configured API credential; no benchmark request was made.");
  }
  return key;
}

export async function fetchScrapingBeeUsedCredits(options: {
  proxyTemplate: string;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const key = apiKeyFromTemplate(options.proxyTemplate);
  const response = await (options.fetchImpl ?? fetch)(SCRAPINGBEE_USAGE_URL, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error("ScrapingBee usage accounting was unavailable.");
  }
  const body = await response.json() as { used_api_credit?: unknown };
  if (typeof body.used_api_credit !== "number") {
    throw new Error("ScrapingBee usage accounting returned an invalid total.");
  }
  return body.used_api_credit;
}

/**
 * Reconcile response-header costs with the account delta without inventing
 * per-query attribution for responses that arrived after the client aborted.
 */
export function reconcileScrapingBeeCredits(
  queries: readonly ProviderQueryCapture[],
  accountDelta: number,
): ScrapingBeeCreditAccounting {
  const headerTotal = queries.reduce(
    (sum, query) => sum + (query.creditsSpent ?? 0),
    0,
  );
  return {
    accountDeltaCredits: accountDelta,
    responseHeaderCredits: headerTotal,
    unattributedCredits: Math.max(0, accountDelta - headerTotal),
  };
}
