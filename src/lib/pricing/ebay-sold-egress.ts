/**
 * Operator configuration for the optional eBay sold-comps proxy seam.
 *
 * The template can contain a provider credential, so validation errors and
 * status objects deliberately never echo it. A missing/blank value means the
 * existing direct-fetch path; a present value must be an absolute HTTPS URL
 * with exactly one `{url}` placeholder for the encoded, SSRF-validated eBay
 * target.
 */

export type EbaySoldEgressConfig =
  | { mode: "direct" }
  | { mode: "proxy"; template: string };
export type EbaySoldEnvironment = Readonly<Record<string, string | undefined>>;

const TARGET_PLACEHOLDER = "{url}";
const VALIDATION_PREFIX = "Invalid EBAY_SOLD_PROXY_TEMPLATE";

function validationError(reason: string): Error {
  return new Error(`${VALIDATION_PREFIX}: ${reason}`);
}

/** Validate and normalize a configured proxy template without exposing it. */
export function validateEbaySoldProxyTemplate(raw: string): string {
  const template = raw.trim();
  const placeholderCount = template.split(TARGET_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw validationError("must contain exactly one {url} placeholder");
  }
  const fragmentIndex = template.indexOf("#");
  if (
    fragmentIndex !== -1 &&
    template.indexOf(TARGET_PLACEHOLDER) > fragmentIndex
  ) {
    throw validationError("must place {url} before the URL fragment");
  }

  let parsed: URL;
  try {
    parsed = new URL(
      template.replace(TARGET_PLACEHOLDER, encodeURIComponent("https://www.ebay.com/")),
    );
  } catch {
    throw validationError("must be an absolute URL");
  }

  if (parsed.protocol !== "https:") {
    throw validationError("must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw validationError("must not embed credentials in URL userinfo");
  }

  return template;
}

/** Resolve optional config. Missing/blank is valid and preserves direct fetch. */
export function resolveEbaySoldEgressConfig(
  env: EbaySoldEnvironment = process.env,
): EbaySoldEgressConfig {
  const raw = env.EBAY_SOLD_PROXY_TEMPLATE;
  if (!raw?.trim()) return { mode: "direct" };
  return { mode: "proxy", template: validateEbaySoldProxyTemplate(raw) };
}

/** Construct the proxy request URL from an already validated operator template. */
export function buildEbaySoldProxyRequestUrl(
  template: string,
  ebayTargetUrl: string,
): string {
  const valid = validateEbaySoldProxyTemplate(template);
  return valid.replace(TARGET_PLACEHOLDER, encodeURIComponent(ebayTargetUrl));
}
