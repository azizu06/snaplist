type Env = Record<string, string | undefined>;

const SANDBOX_API_ORIGIN = "https://api.sandbox.ebay.com";
const PRODUCTION_API_ORIGIN = "https://api.ebay.com";

export class EbayProductionMobileDisabledError extends Error {}

export function assertMobileEbayOperatorActivation(env: Env): string {
  const configured = env.EBAY_BASE_URL ?? SANDBOX_API_ORIGIN;
  if (!/^https:\/\/[^/?#]+\/?$/i.test(configured)) {
    throw invalidMobileEbayBaseUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw invalidMobileEbayBaseUrl();
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/") {
    throw invalidMobileEbayBaseUrl();
  }

  if (parsed.origin === SANDBOX_API_ORIGIN) return SANDBOX_API_ORIGIN;

  if (parsed.origin === PRODUCTION_API_ORIGIN) {
    if (env.EBAY_PRODUCTION_MOBILE_ENABLED !== "true") {
      throw new EbayProductionMobileDisabledError(
        "Production mobile eBay OAuth and publish are disabled. Set "
          + 'EBAY_PRODUCTION_MOBILE_ENABLED="true" to activate them.',
      );
    }
    return PRODUCTION_API_ORIGIN;
  }

  throw invalidMobileEbayBaseUrl();
}

function invalidMobileEbayBaseUrl(): Error {
  return new Error(
    "Mobile eBay OAuth and publish require EBAY_BASE_URL to be the bare "
      + "Sandbox or Production API origin.",
  );
}
