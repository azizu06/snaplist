/** Local and authoritative marketplace fields that determine review mutability. */
export interface ReviewRegenerationListingState {
  status?: string | null;
  ebayListingId?: string | null;
  ebayStatus?: string | null;
}

/** True once review changes could race or rewrite a publishing/live eBay listing. */
export function isReviewRegenerationBlocked(
  listing: ReviewRegenerationListingState,
): boolean {
  return (
    listing.status === "published" ||
    Boolean(listing.ebayListingId) ||
    listing.ebayStatus === "publishing" ||
    listing.ebayStatus === "published"
  );
}
