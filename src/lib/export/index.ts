/**
 * Export-pack public surface (issue #15). One Zod-validated attribute core →
 * Facebook Marketplace + Mercari copy-paste packs, each following its
 * platform's conventions (FB: casual / short / local pickup; Mercari: ≤ 40-char
 * title, hashtags, shipping-oriented), each rendered as one clean paste-able
 * block and carrying the caller-resolved effective price as a separate field.
 * Constraints are enforced STRUCTURALLY (Zod caps, hashtag bounds, the
 * core-derived hashtag whitelist, token-boundary title grounding) on top of
 * the prompt rules, and the model call is injectable so the contract tests run
 * fully offline. Titles are grounded model output; DESCRIPTIONS are assembled
 * deterministically from the validated core (never model free text), so no
 * channel exists for invented attributes to reach the published packs.
 */
export {
  FACEBOOK_PLATFORM,
  FACEBOOK_TITLE_MAX_LENGTH,
  FACEBOOK_DESCRIPTION_MAX_LENGTH,
  MERCARI_PLATFORM,
  MERCARI_TITLE_MAX_LENGTH,
  MERCARI_DESCRIPTION_MAX_LENGTH,
  MERCARI_MAX_HASHTAGS,
  facebookPackSchema,
  mercariPackSchema,
  mercariHashtagSchema,
  rawExportPacksSchema,
  type FacebookPack,
  type MercariPack,
  type RawExportPacks,
} from "./schema";

export {
  generateExportPacks,
  createOpenAIExportPackGenerate,
  facebookCopyBlock,
  mercariCopyBlock,
  facebookPackToListingCopy,
  mercariPackToListingCopy,
  normalizeHashtag,
  reconcileHashtags,
  deriveDefaultHashtags,
  derivableHashtagBodies,
  packsHallucinateAttributes,
  repairMercariDescription,
  buildCoreDescription,
  buildFacebookDescription,
  buildMercariDescription,
  formatPrice,
  FACEBOOK_PICKUP_LINE,
  MERCARI_SHIPPING_SUFFIX,
  type ExportPackGenerate,
  type GenerateExportPacksInput,
  type GenerateExportPacksResult,
  type ExportPackResult,
} from "./generate";

export {
  loadOrGenerateExportPacks,
  type ExportPackView,
  type ExportPacksView,
  type LoadOrGeneratePacksInput,
} from "./persist";
