/**
 * Public surface of the eBay marketplace adapter (issue #14).
 *
 * Callers import from here; the adapter seam (`EbayAdapter`) is the only thing
 * the rest of SnapList depends on. `createEbayAdapter()` is the production
 * composition root: the real HTTP adapter with the app-level env token
 * provider. Tests construct `MockEbayAdapter` directly.
 */
export type {
  EbayAdapter,
  EbayPublishRequest,
  EbayPublishResult,
  EbayTokenProvider,
  EbayCondition,
} from "./types";
export { EbayApiError } from "./types";
export { HttpEbayAdapter } from "./http";
export { MockEbayAdapter } from "./mock";
export { EnvTokenProvider } from "./auth";
export {
  toEbayPublishRequest,
  toEbayCondition,
  toEbayAspects,
  toEbayPrice,
  type ListingForPublish,
} from "./map";
export { publishListingToEbay, type PublishOutcome } from "./publish";

import type { EbayAdapter } from "./types";
import { HttpEbayAdapter } from "./http";

/**
 * The real adapter, wired for the current environment. Sandbox by default
 * (`EBAY_BASE_URL`); production is a credential/URL flip (docs/ebay-sandbox.md).
 * Env is read lazily inside the adapter, so calling this is always safe.
 */
export function createEbayAdapter(): EbayAdapter {
  return new HttpEbayAdapter();
}
