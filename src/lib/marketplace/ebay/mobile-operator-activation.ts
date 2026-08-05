type Env = Record<string, string | undefined>;

const SANDBOX_API_ORIGIN = "https://api.sandbox.ebay.com";
const PRODUCTION_API_ORIGIN = "https://api.ebay.com";

function isBareOrigin(configured: string, origin: string): boolean {
  return configured === origin || configured === `${origin}/`;
}

export function assertMobileEbayOperatorActivation(env: Env): void {
  const configured = env.EBAY_BASE_URL ?? SANDBOX_API_ORIGIN;

  if (isBareOrigin(configured, SANDBOX_API_ORIGIN)) return;

  if (isBareOrigin(configured, PRODUCTION_API_ORIGIN)) {
    if (env.EBAY_PRODUCTION_MOBILE_ENABLED !== "true") {
      throw new Error(
        "Production mobile eBay OAuth and publish are disabled. Set "
          + 'EBAY_PRODUCTION_MOBILE_ENABLED="true" to activate them.',
      );
    }
    return;
  }

  throw new Error(
    "Mobile eBay OAuth and publish require EBAY_BASE_URL to be the bare "
      + "Sandbox or Production API origin.",
  );
}
