/**
 * Vision module public surface (issue #6). Real single-shot multimodal extraction
 * → Zod-validated attributes + a flagged identification, composed into the existing
 * `Pipeline` seam. Swap `createVisionPipeline` in for the stub at the upload call site.
 */
export {
  extractItemAttributes,
  createOpenAIVisionGenerate,
  deriveIdentification,
  identificationEvidence,
  DEFAULT_VISION_MODEL,
  MIN_IMAGES,
  MAX_IMAGES,
  type VisionGenerate,
  type VisionGenerateResult,
  type VisionImageInput,
  type ExtractItemAttributesInput,
  type ExtractItemAttributesResult,
} from "./extract";
export {
  resolvePhotoImages,
  resolvePhotoImageData,
  PHOTOS_BUCKET,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type SignedUrlClient,
  type DownloadClient,
  type PhotoImageData,
} from "./photos";
export {
  createVisionPipeline,
  createDefaultPricer,
  type CreateVisionPipelineOptions,
  type CreateDefaultPricerOptions,
} from "./pipeline";
