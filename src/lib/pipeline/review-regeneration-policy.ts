export interface ReviewRegenerationListingState {
  status?: string | null;
  ebayListingId?: string | null;
  ebayStatus?: string | null;
}

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
