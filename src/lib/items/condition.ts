export function normalizeConditionAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

export function canonicalizeCondition(value: string): string {
  const normalized = normalizeConditionAlias(value);
  switch (normalized) {
    case "like new":
      return "like-new";
    case "very good":
      return "very-good";
    case "for parts":
      return "for-parts";
    default:
      return normalized;
  }
}
