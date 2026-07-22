import type { ItemSignal } from "./types";

export type SoldCompCondition =
  | "new"
  | "refurbished"
  | "open-box"
  | "like-new"
  | "used-good"
  | "used-fair"
  | "parts"
  | "unknown";

export type SoldCompClassification = "anchor" | "corroboration" | "reject";

export type SoldCompMatchReason =
  | "identity-equivalent"
  | "identity-partial"
  | "identity-unverified"
  | "identity-mismatch"
  | "variant-conflict"
  | "spec-equivalent"
  | "spec-unverified"
  | "spec-conflict"
  | "condition-same"
  | "condition-adjacent"
  | "condition-distant"
  | "condition-unknown"
  | "accessory-mismatch"
  | "composition-mismatch"
  | "parts-mismatch"
  | "quantity-mismatch"
  | "accepted-price-unknown";

export interface SoldCompCandidate {
  /** Stable provider-neutral identity when the retrieval adapter exposes one. */
  id?: string;
  /** Canonical sold-listing URL; preferred as the stable ranking tie-break. */
  url?: string;
  /** Persisted/read-side alias for a canonical sold-listing URL. */
  sourceUrl?: string;
  title?: string;
  price: number;
  condition?: string | null;
  soldAt?: number;
  isBestOfferAccepted?: boolean;
  priceDisclosure?: "displayed-sold-price" | "asking-price-not-accepted-amount";
}

export interface SoldCompMatch<T extends SoldCompCandidate = SoldCompCandidate> {
  comp: T;
  classification: SoldCompClassification;
  score: number;
  sellerCondition: SoldCompCondition;
  compCondition: SoldCompCondition;
  reasons: SoldCompMatchReason[];
}

export interface SoldCompEvidence<T extends SoldCompCandidate = SoldCompCandidate> {
  anchors: SoldCompMatch<T>[];
  corroboration: SoldCompMatch<T>[];
  rejected: SoldCompMatch<T>[];
}

export const MAX_VERIFIED_SOLD_MATCHES = 5;

function stableSoldCompKey(comp: SoldCompCandidate): string {
  return (
    comp.url ??
    comp.sourceUrl ??
    comp.id ??
    [
      normalizeComparableText(comp.title ?? ""),
      comp.price,
      normalizeComparableText(comp.condition ?? ""),
      comp.soldAt ?? "",
    ].join("|")
  );
}

function compareVerifiedMatches<T extends SoldCompCandidate>(
  left: SoldCompMatch<T>,
  right: SoldCompMatch<T>,
): number {
  const leftKey = stableSoldCompKey(left.comp);
  const rightKey = stableSoldCompKey(right.comp);
  return (
    right.score - left.score ||
    (right.comp.soldAt ?? Number.NEGATIVE_INFINITY) -
      (left.comp.soldAt ?? Number.NEGATIVE_INFINITY) ||
    (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
  );
}

/**
 * Deduplicate and retain the strongest verified sold matches from one canonical
 * matcher result. Ranking is match quality first, then recency, then a stable
 * provider-neutral identity so retrieval order can never affect the projection.
 */
export function selectVerifiedSoldMatches<T extends SoldCompCandidate>(
  matches: readonly SoldCompMatch<T>[],
  limit = MAX_VERIFIED_SOLD_MATCHES,
): SoldCompMatch<T>[] {
  const bestByIdentity = new Map<string, SoldCompMatch<T>>();
  for (const match of matches) {
    if (match.classification !== "anchor") continue;
    const key = stableSoldCompKey(match.comp);
    const previous = bestByIdentity.get(key);
    if (!previous || compareVerifiedMatches(match, previous) < 0) {
      bestByIdentity.set(key, match);
    }
  }
  return [...bestByIdentity.values()]
    .sort(compareVerifiedMatches)
    .slice(0, Math.max(0, Math.min(MAX_VERIFIED_SOLD_MATCHES, limit)));
}

const CONDITION_RANK: Partial<Record<SoldCompCondition, number>> = {
  "used-fair": 0,
  "used-good": 1,
  "like-new": 2,
  "open-box": 3,
  new: 4,
};

const VARIANT_WORDS = new Set([
  "air",
  "lite",
  "max",
  "mini",
  "plus",
  "pro",
  "se",
  "signature",
  "slim",
  "ultra",
  "xl",
  "xr",
  "xs",
]);

const APPAREL_FORMS = new Set([
  "coat",
  "hoodie",
  "jacket",
  "pants",
  "shirt",
  "shorts",
  "sweater",
  "sweatshirt",
  "vest",
]);

const ACCESSORY_WORDS = [
  "adapter",
  "battery grip",
  "cable",
  "case",
  "charger",
  "charging dock",
  "controller",
  "cord",
  "cover",
  "dock",
  "ear pad",
  "ear pads",
  "empty box",
  "grip",
  "holder",
  "manual only",
  "mount",
  "pouch",
  "protector",
  "replacement",
  "screen protector",
  "sheath only",
  "shell",
  "sleeve",
  "stand",
  "strap",
  "study guide",
  "summary",
  "workbook",
  "box only",
  "instructions only",
  "lens only",
  "lid only",
  "minifigures only",
  "left earbud",
  "right earbud",
  "single earbud",
  "straw only",
  "tablet only",
];

const PARTS_RE = /\b(for parts|parts only|not working|broken|faulty|repair|as is)\b/i;
const MULTI_UNIT_RE =
  /\b(\d+\s*[- ]?pack|pack of \d+|set of \d+|lot of \d+|\d+\s*pcs?|\d+\s*pieces?)\b/i;

export function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bplaystation\s*5\b/g, "ps5")
    .replace(/\bgame\s+boy\s+advance\b/g, "gba")
    .replace(/\blevi['’]?s\b/g, "levis")
    .replace(/\bwave\s*\+/g, "wave plus")
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+gen(?:eration)?\b/g, "$1 generation")
    .replace(/\bgen(?:eration)?\b/g, "generation")
    .replace(/\busb[\s_-]*c\b/g, "usb c")
    .replace(/\b(\d+)\s*(gb|tb|mb)\b/g, "$1 $2")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSoldCompCondition(value?: string | null): SoldCompCondition {
  const condition = normalizeComparableText(value ?? "");
  if (!condition) return "unknown";
  if (/\b(for parts|parts only|not working|broken|faulty|repair|as is)\b/.test(condition)) {
    return "parts";
  }
  if (/\b(refurbished|remanufactured)\b/.test(condition)) return "refurbished";
  if (/\b(open box|open package)\b/.test(condition)) return "open-box";
  if (/\b(like new|near mint|mint condition)\b/.test(condition)) return "like-new";
  if (
    /\b(brand new|new with tags|new without tags|new in box|factory sealed|unopened|sealed|new)\b/.test(
      condition,
    )
  ) {
    return "new";
  }
  if (/\b(acceptable|fair|poor|heavily used)\b/.test(condition)) return "used-fair";
  if (/\b(pre owned|used|very good|good|excellent)\b/.test(condition)) return "used-good";
  return "unknown";
}

function identityText(signal: ItemSignal): string {
  return normalizeComparableText(
    [signal.brand, signal.model, signal.resolvedName, ...(signal.specs ?? [])]
      .filter(Boolean)
      .join(" "),
  );
}

function containsPhrase(text: string, phrase: string): boolean {
  return (` ${text} `).includes(` ${phrase} `);
}

function modelIdentity(signal: ItemSignal): string {
  return normalizeComparableText(signal.model ?? signal.resolvedName ?? "");
}

function modelMatches(title: string, signal: ItemSignal): boolean {
  const model = modelIdentity(signal);
  if (!model) return true;
  const tokens = model.match(/[a-z0-9]+/g);
  if (!tokens?.length) return true;
  const pattern = `(?<![a-z0-9])${tokens.join("\\s*")}(?![a-z0-9])`;
  return new RegExp(pattern, "i").test(title);
}

function modelConflict(title: string, signal: ItemSignal): boolean {
  const model = modelIdentity(signal);
  if (!model) return false;
  const expectedWords = model.split(" ");
  const titleWords = title.split(" ");
  const expectedNumeric = expectedWords.filter((word) => /\d/.test(word));
  const titleNumeric = titleWords.filter((word) => /\d/.test(word));

  for (const expected of expectedNumeric) {
    for (const observed of titleNumeric) {
      if (expected === observed) continue;
      const shared = [...expected].findIndex((char, index) => observed[index] !== char);
      const prefixLength = shared === -1 ? Math.min(expected.length, observed.length) : shared;
      if (
        (expected.startsWith(observed) || observed.startsWith(expected) ||
          prefixLength >= Math.min(expected.length, observed.length) - 1) &&
        Math.min(expected.length, observed.length) >= 3
      ) {
        return true;
      }
    }
  }

  const familyWords = expectedWords.filter(
    (word) => word.length >= 4 && !VARIANT_WORDS.has(word) && !/\d/.test(word),
  );
  const sharesFamily = familyWords.some((word) => titleWords.includes(word));
  if (
    sharesFamily &&
    expectedNumeric.length > 0 &&
    titleNumeric.length > 0 &&
    !expectedNumeric.some((word) => titleNumeric.includes(word))
  ) {
    return true;
  }
  return false;
}

function variantConflict(title: string, signal: ItemSignal): boolean {
  const model = modelIdentity(signal);
  if (!model) return false;
  const modelWords = new Set(model.split(" "));
  const titleWords = new Set(title.split(" "));
  if (
    [...APPAREL_FORMS].some(
      (form) =>
        titleWords.has(form) &&
        !modelWords.has(form) &&
        !(form === "jacket" && modelWords.has("sweater")),
    )
  ) {
    return true;
  }
  if (!modelMatches(title, signal)) return false;
  for (const variant of VARIANT_WORDS) {
    if (titleWords.has(variant) && !modelWords.has(variant)) return true;
  }
  return false;
}

function capacityTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  return new Set(
    Array.from(normalized.matchAll(/\b(\d+)\s+(gb|tb|mb)\b/g), (match) => `${match[1]} ${match[2]}`),
  );
}

function numericSizeTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  const matches = [
    ...normalized.matchAll(/\b(?:size|sz)\s*(\d+(?:\.\d+)?)\b/g),
    ...normalized.matchAll(/\b(?:mens?|men s|womens?|women s)\s+(\d+(?:\.\d+)?)\b/g),
  ];
  return new Set(matches.map((match) => match[1]));
}

function namedSizeTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value)
    .replace(/\bsize\s+m\b/g, "medium")
    .replace(/\bsize\s+l\b/g, "large")
    .replace(/\bsize\s+s\b/g, "small")
    .replace(/\bsize\s+xl\b/g, "extra large");
  return new Set(
    ["small", "medium", "large", "extra large"].filter((size) =>
      containsPhrase(normalized, size),
    ),
  );
}

function dimensionTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  return new Set(
    Array.from(normalized.matchAll(/\b(\d+)\s*x\s*(\d+)\b/g), (match) => `${match[1]}x${match[2]}`),
  );
}

function volumeTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  return new Set(
    Array.from(normalized.matchAll(/\b(\d+)\s*oz\b/g), (match) => `${match[1]} oz`),
  );
}

function gpuTokens(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  return new Set(
    Array.from(normalized.matchAll(/\b(rtx|gtx)\s*(\d{3,4})\b/g), (match) => `${match[1]} ${match[2]}`),
  );
}

function relation(
  expected: ReadonlySet<string>,
  observed: ReadonlySet<string>,
): "equivalent" | "unverified" | "conflict" {
  if (expected.size === 0) return "unverified";
  if (observed.size === 0) return "unverified";
  return [...expected].every((token) => observed.has(token)) ? "equivalent" : "conflict";
}

function genderConflict(title: string, specs: string): boolean {
  const expected = normalizeComparableText(specs);
  const observed = normalizeComparableText(title);
  const expectsMen = /\b(mens|men s|male)\b/.test(expected);
  const expectsWomen = /\b(womens|women s|female)\b/.test(expected);
  if (expectsMen && /\b(womens|women s|girls?|kids?)\b/.test(observed)) return true;
  if (expectsWomen && /\b(mens|men s|boys?|kids?)\b/.test(observed)) return true;
  return false;
}

function compositionConflict(title: string, specs: string): boolean {
  const expected = normalizeComparableText(specs);
  const observed = normalizeComparableText(title);
  if (containsPhrase(expected, "body only") && /\b(lens|kit)\b/.test(observed)) return true;
  if (containsPhrase(expected, "complete") && /\b(incomplete|missing|partial)\b/.test(observed)) {
    return true;
  }
  if (containsPhrase(expected, "sealed") && /\b(open box|used|pre owned|incomplete)\b/.test(observed)) {
    return true;
  }
  return false;
}

function audienceConflict(title: string, signal: ItemSignal, specs: string): boolean {
  if (normalizeComparableText(signal.category ?? "") !== "sneakers") return false;
  const expected = normalizeComparableText(specs);
  const observed = normalizeComparableText(title);
  const expectsYouth = /\b(kids?|youth|grade school|gs)\b/.test(expected);
  return !expectsYouth && /\b(kids?|youth|grade school|gs)\b/.test(observed);
}

function compositionEquivalent(title: string, specs: string): boolean {
  const expected = normalizeComparableText(specs);
  const observed = normalizeComparableText(title);
  const markers: Array<[RegExp, RegExp]> = [
    [/\bbody only\b/, /\bbody only\b/],
    [/\bcomplete\b/, /\b(complete|complete set|full set)\b/],
    [/\bsealed\b/, /\b(sealed|factory sealed|new in box|nib)\b/],
    [/\bfull zip\b/, /\bfull zip\b/],
  ];
  return markers.some(
    ([expectedPattern, observedPattern]) =>
      expectedPattern.test(expected) && observedPattern.test(observed),
  );
}

function compareSpecs(title: string, signal: ItemSignal): "equivalent" | "unverified" | "conflict" {
  const specs = (signal.specs ?? []).join(" ");
  if (!specs.trim()) return "unverified";
  if (
    genderConflict(title, specs) ||
    audienceConflict(title, signal, specs) ||
    compositionConflict(title, specs)
  ) {
    return "conflict";
  }

  const normalizedSpecs = (signal.specs ?? [])
    .map((spec) => normalizeComparableText(spec))
    .filter(Boolean);
  if (
    normalizedSpecs.every((spec) => containsPhrase(title, spec)) ||
    compositionEquivalent(title, specs)
  ) {
    return "equivalent";
  }

  const relations = [
    relation(capacityTokens(specs), capacityTokens(title)),
    relation(numericSizeTokens(specs), numericSizeTokens(title)),
    relation(namedSizeTokens(specs), namedSizeTokens(title)),
    relation(dimensionTokens(specs), dimensionTokens(title)),
    relation(volumeTokens(specs), volumeTokens(title)),
    relation(gpuTokens(specs), gpuTokens(title)),
  ];
  if (relations.includes("conflict")) return "conflict";
  return relations.includes("equivalent") ? "equivalent" : "unverified";
}

function hasMaterialSpecs(signal: ItemSignal): boolean {
  return (signal.specs ?? []).some((spec) => normalizeComparableText(spec).length > 0);
}

function exactIdentifierMatches(title: string, signal: ItemSignal): boolean {
  return [signal.isbn, signal.upc].some((identifier) => {
    const normalized = normalizeComparableText(identifier ?? "");
    return normalized.length > 0 && containsPhrase(title, normalized);
  });
}

function accessoryPhrases(accessory: string): string[][] {
  const singular = accessory.split(" ");
  const last = singular.at(-1);
  if (!last || last.endsWith("s")) return [singular];
  return [singular, [...singular.slice(0, -1), `${last}s`]];
}

function accessoryQuantity(text: string, accessory: string): number {
  const tokens = text.split(" ");
  for (const phrase of accessoryPhrases(accessory)) {
    for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
      if (!phrase.every((word, offset) => tokens[index + offset] === word)) continue;
      for (let before = index - 1; before >= Math.max(0, index - 3); before -= 1) {
        if (/^\d+$/.test(tokens[before])) return Number(tokens[before]);
      }
      return 1;
    }
  }
  return 0;
}

const ACCESSORY_INCLUSION_WORDS = new Set(["with", "include", "includes", "including"]);

function accessoryIsIncluded(text: string, accessory: string): boolean {
  const tokens = text.split(" ");
  let found = false;
  for (const phrase of accessoryPhrases(accessory)) {
    for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
      if (!phrase.every((word, offset) => tokens[index + offset] === word)) continue;
      found = true;
      if (!tokens.slice(0, index).some((word) => ACCESSORY_INCLUSION_WORDS.has(word))) {
        return false;
      }
    }
  }
  return found;
}

function accessoryMismatch(title: string, signal: ItemSignal): boolean {
  const identity = identityText(signal);
  for (const accessory of ACCESSORY_WORDS) {
    if (accessoryQuantity(title, accessory) === 0) continue;
    if (accessoryQuantity(identity, accessory) > 0) continue;
    if (accessoryIsIncluded(title, accessory)) continue;
    return true;
  }
  return false;
}

function compositionMismatch(title: string, signal: ItemSignal): boolean {
  const identity = identityText(signal);
  const titleIsBundle = containsPhrase(title, "bundle");
  const targetIsBundle = containsPhrase(identity, "bundle");
  if (titleIsBundle && !targetIsBundle) return true;

  return ACCESSORY_WORDS.some((accessory) => {
    const observed = accessoryQuantity(title, accessory);
    if (observed === 0) return false;
    const expected = accessoryQuantity(identity, accessory);
    if (observed === expected) return false;
    return titleIsBundle || observed > 1 || expected > 0;
  });
}

function stripIdentityFromTitle(title: string, signal: ItemSignal): string {
  let stripped = ` ${title} `;
  for (const phrase of [signal.brand, signal.model, signal.resolvedName]) {
    const normalized = normalizeComparableText(phrase ?? "");
    if (!normalized) continue;
    stripped = stripped.replaceAll(` ${normalized} `, " ");
  }
  return stripped.trim();
}

function conditionFromCandidate(
  comp: SoldCompCandidate,
  title: string,
  signal: ItemSignal,
): SoldCompCondition {
  const metadata = normalizeSoldCompCondition(comp.condition);
  return metadata === "unknown"
    ? normalizeSoldCompCondition(stripIdentityFromTitle(title, signal))
    : metadata;
}

function reject<T extends SoldCompCandidate>(
  comp: T,
  sellerCondition: SoldCompCondition,
  compCondition: SoldCompCondition,
  reason: SoldCompMatchReason,
  reasons: SoldCompMatchReason[] = [],
): SoldCompMatch<T> {
  return {
    comp,
    classification: "reject",
    score: 0,
    sellerCondition,
    compCondition,
    reasons: [...reasons, reason],
  };
}

export function classifySoldComp<T extends SoldCompCandidate>(
  comp: T,
  signal: ItemSignal,
): SoldCompMatch<T> {
  const title = normalizeComparableText(comp.title ?? "");
  const sellerCondition = normalizeSoldCompCondition(signal.condition);
  const compCondition = conditionFromCandidate(comp, title, signal);
  const reasons: SoldCompMatchReason[] = [];
  let identityVerified = true;

  if (
    comp.isBestOfferAccepted ||
    comp.priceDisclosure === "asking-price-not-accepted-amount"
  ) {
    return reject(comp, sellerCondition, compCondition, "accepted-price-unknown");
  }

  const model = modelIdentity(signal);
  if (model) {
    if (!modelMatches(title, signal)) {
      if (variantConflict(title, signal)) {
        return reject(comp, sellerCondition, compCondition, "variant-conflict");
      }
      if (modelConflict(title, signal)) {
        return reject(comp, sellerCondition, compCondition, "identity-mismatch");
      }
      reasons.push("identity-partial");
      identityVerified = false;
    } else {
      reasons.push("identity-equivalent");
      if (variantConflict(title, signal)) {
        return reject(comp, sellerCondition, compCondition, "variant-conflict", reasons);
      }
    }
  } else {
    if (exactIdentifierMatches(title, signal)) {
      reasons.push("identity-equivalent");
    } else {
      reasons.push("identity-unverified");
      identityVerified = false;
    }
  }

  const specs = compareSpecs(title, signal);
  if (specs === "conflict") {
    return reject(comp, sellerCondition, compCondition, "spec-conflict", reasons);
  }
  reasons.push(specs === "equivalent" ? "spec-equivalent" : "spec-unverified");
  if (specs === "unverified" && hasMaterialSpecs(signal)) identityVerified = false;

  if (MULTI_UNIT_RE.test(title)) {
    return reject(comp, sellerCondition, compCondition, "quantity-mismatch", reasons);
  }
  if (accessoryMismatch(title, signal)) {
    return reject(comp, sellerCondition, compCondition, "accessory-mismatch", reasons);
  }

  const sellerParts = sellerCondition === "parts";
  const compParts = compCondition === "parts" || PARTS_RE.test(title);
  if (sellerParts !== compParts) {
    return reject(comp, sellerCondition, compCondition, "parts-mismatch", reasons);
  }

  if (compositionMismatch(title, signal)) {
    reasons.push("composition-mismatch");
    return {
      comp,
      classification: "corroboration",
      score: identityVerified ? 0.65 : 0.58,
      sellerCondition,
      compCondition,
      reasons,
    };
  }

  if (sellerCondition === "unknown") {
    reasons.push("condition-unknown");
    return {
      comp,
      classification: "corroboration",
      score: identityVerified ? 0.68 : 0.6,
      sellerCondition,
      compCondition,
      reasons,
    };
  }

  if (compCondition === "unknown") {
    reasons.push("condition-unknown");
    return {
      comp,
      classification: identityVerified ? "anchor" : "corroboration",
      score: identityVerified ? (specs === "equivalent" ? 0.8 : 0.76) : 0.68,
      sellerCondition,
      compCondition,
      reasons,
    };
  }

  if (sellerCondition === compCondition) {
    reasons.push("condition-same");
    return {
      comp,
      classification: identityVerified ? "anchor" : "corroboration",
      score: identityVerified ? (specs === "equivalent" ? 0.98 : 0.95) : 0.7,
      sellerCondition,
      compCondition,
      reasons,
    };
  }

  const sellerRank = CONDITION_RANK[sellerCondition];
  const compRank = CONDITION_RANK[compCondition];
  if (sellerRank !== undefined && compRank !== undefined && Math.abs(sellerRank - compRank) === 1) {
    reasons.push("condition-adjacent");
    return {
      comp,
      classification: identityVerified ? "anchor" : "corroboration",
      score: identityVerified ? (specs === "equivalent" ? 0.88 : 0.85) : 0.66,
      sellerCondition,
      compCondition,
      reasons,
    };
  }

  reasons.push("condition-distant");
  return {
    comp,
    classification: "corroboration",
    score: specs === "equivalent" ? 0.64 : 0.6,
    sellerCondition,
    compCondition,
    reasons,
  };
}

export function selectSoldCompEvidence<T extends SoldCompCandidate>(
  comps: readonly T[],
  signal: ItemSignal,
): SoldCompEvidence<T> {
  const evidence: SoldCompEvidence<T> = { anchors: [], corroboration: [], rejected: [] };
  for (const comp of comps) {
    const match = classifySoldComp(comp, signal);
    if (match.classification === "anchor") evidence.anchors.push(match);
    else if (match.classification === "corroboration") evidence.corroboration.push(match);
    else evidence.rejected.push(match);
  }
  return evidence;
}
