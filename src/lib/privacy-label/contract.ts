import { XMLParser } from "fast-xml-parser";

/**
 * The App Store Connect privacy label and `PrivacyInfo.xcprivacy` are the same
 * declaration made twice: once by a human into Apple's web form, once by a file
 * into the build. `docs/app-store-connect-privacy-label.md` is what the human
 * copies from, so when it drifts from the manifest the submitted label is wrong
 * — and a wrong label is caught after submission, not before it.
 *
 * It had drifted: the doc carried two rows while the manifest declared nine,
 * omitting photos, audio, and email (#953). This module parses both sides so a
 * test can prove they agree, and so the doc can be *derived* from the manifest
 * rather than remembered.
 *
 * Nothing here encodes knowledge of Apple's category taxonomy. The only claim
 * it makes about Apple is that a manifest constant and the App Store Connect
 * data-type name are the same words — see `foldForComparison`.
 */

/** One `NSPrivacyCollectedDataTypes` entry, as declared. */
export interface DeclaredDataType {
  /** The exact `NSPrivacyCollectedDataType*` constant. */
  readonly manifestKey: string;
  /** The exact `NSPrivacyCollectedDataTypePurpose*` constants, in file order. */
  readonly purposeKeys: readonly string[];
  readonly linkedToUser: boolean;
  readonly usedForTracking: boolean;
}

/** One row of the doc's table, cell text verbatim. */
export interface PrivacyLabelRow {
  readonly dataType: string;
  readonly collected: string;
  readonly purpose: string;
  readonly linkedToUser: string;
  readonly usedForTracking: string;
}

/** The table's columns, in order. A rename shifts every mapping silently. */
export const PRIVACY_LABEL_COLUMNS = [
  "Data type",
  "Collected",
  "Purpose",
  "Linked to user",
  "Used for tracking",
] as const;

const COLLECTED_TYPE_PREFIX = "NSPrivacyCollectedDataType";
const PURPOSE_PREFIX = "NSPrivacyCollectedDataTypePurpose";

type PlistValue =
  string | boolean | PlistValue[] | { [key: string]: PlistValue };
type OrderedNode = Record<string, unknown>;

function tagOf(node: OrderedNode): [string, unknown] {
  const entries = Object.entries(node);
  if (entries.length !== 1) {
    throw new Error(
      `expected one plist element per node, saw ${entries.length}`,
    );
  }
  return entries[0];
}

function childrenOf(value: unknown, tag: string): OrderedNode[] {
  if (!Array.isArray(value)) throw new Error(`<${tag}> has no parsed children`);
  return value as OrderedNode[];
}

/** `<string>x</string>` parses to `[{ "#text": "x" }]`; `<string/>` to `[]`. */
function textOf(children: OrderedNode[]): string {
  if (children.length === 0) return "";
  const text = children[0]["#text"];
  if (typeof text !== "string") throw new Error("expected character data");
  return text;
}

function plistValue(node: OrderedNode): PlistValue {
  const [tag, raw] = tagOf(node);
  switch (tag) {
    case "true":
      return true;
    case "false":
      return false;
    case "string":
      return textOf(childrenOf(raw, tag));
    case "array":
      return childrenOf(raw, tag).map(plistValue);
    case "dict":
      return plistDict(childrenOf(raw, tag));
    default:
      // Silently ignoring an element type would drop a declaration. Anything
      // this parser has not been taught is a reason to stop, not to guess.
      throw new Error(`unsupported plist element <${tag}>`);
  }
}

/** A plist dict is a flat `key`/value alternation, not a nested structure. */
function plistDict(children: OrderedNode[]): { [key: string]: PlistValue } {
  const result: { [key: string]: PlistValue } = {};
  for (let index = 0; index < children.length; index += 2) {
    const [tag, raw] = tagOf(children[index]);
    if (tag !== "key")
      throw new Error(`expected <key> at dict position ${index}, saw <${tag}>`);
    const name = textOf(childrenOf(raw, tag));
    const value = children[index + 1];
    if (value === undefined) throw new Error(`<key>${name}</key> has no value`);
    if (name in result) throw new Error(`<key>${name}</key> is declared twice`);
    result[name] = plistValue(value);
  }
  return result;
}

function requireString(
  entry: { [key: string]: PlistValue },
  key: string,
): string {
  const value = entry[key];
  if (typeof value !== "string" || value === "")
    throw new Error(`${key} is missing or not a string`);
  return value;
}

function requireBoolean(
  entry: { [key: string]: PlistValue },
  key: string,
): boolean {
  const value = entry[key];
  if (typeof value !== "boolean")
    throw new Error(`${key} is missing or not a boolean`);
  return value;
}

/**
 * Every `NSPrivacyCollectedDataTypes` entry, with every field the App Store
 * Connect form asks about. A partially declared entry throws rather than
 * producing a row with a defaulted answer.
 */
export function parseCollectedDataTypes(xcprivacy: string): DeclaredDataType[] {
  const tree = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  }).parse(xcprivacy) as OrderedNode[];

  const plist = tree.find((node) => "plist" in node);
  if (!plist) throw new Error("no <plist> root");
  const root = childrenOf(plist.plist, "plist").find((node) => "dict" in node);
  if (!root) throw new Error("<plist> has no root <dict>");

  const manifest = plistDict(childrenOf(root.dict, "dict"));
  const collected = manifest.NSPrivacyCollectedDataTypes;
  if (!Array.isArray(collected))
    throw new Error("NSPrivacyCollectedDataTypes is missing");

  const seen = new Set<string>();
  return collected.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        "NSPrivacyCollectedDataTypes entries must be dictionaries",
      );
    }
    const record = entry as { [key: string]: PlistValue };
    const manifestKey = requireString(record, "NSPrivacyCollectedDataType");
    if (seen.has(manifestKey))
      throw new Error(`${manifestKey} is declared twice`);
    seen.add(manifestKey);

    const purposes = record.NSPrivacyCollectedDataTypePurposes;
    if (!Array.isArray(purposes) || purposes.length === 0) {
      throw new Error(`${manifestKey} declares no purposes`);
    }
    return {
      manifestKey,
      purposeKeys: purposes.map((purpose) => {
        if (typeof purpose !== "string" || purpose === "") {
          throw new Error(`${manifestKey} has a purpose that is not a string`);
        }
        return purpose;
      }),
      linkedToUser: requireBoolean(record, "NSPrivacyCollectedDataTypeLinked"),
      usedForTracking: requireBoolean(
        record,
        "NSPrivacyCollectedDataTypeTracking",
      ),
    };
  });
}

/**
 * The doc's label table. A renamed or reordered column throws, because the
 * mapping from cell position to question would otherwise shift in silence and
 * the label would still look filled in.
 *
 * The table is located as a contiguous run of pipe-prefixed lines rather than
 * by collecting every such line in the file, so a second table — or a fenced
 * block that happens to contain pipes — cannot be spliced into this one. When
 * the file holds several runs, the one whose first column is the expected
 * heading wins; a lone run is used as-is so that renaming a column still
 * reports the rename rather than reporting the table missing.
 */
export function parsePrivacyLabelRows(markdown: string): PrivacyLabelRow[] {
  const cells = (line: string) =>
    line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());

  const blocks: string[][] = [];
  for (const line of markdown.split("\n").map((raw) => raw.trim())) {
    if (!line.startsWith("|")) {
      if (blocks.at(-1)?.length) blocks.push([]);
      continue;
    }
    if (!blocks.length) blocks.push([]);
    blocks.at(-1)!.push(line);
  }

  const tables = blocks.filter((block) => block.length > 0);
  const lines =
    tables.length === 1
      ? tables[0]
      : tables.find((block) => cells(block[0])[0] === PRIVACY_LABEL_COLUMNS[0]);
  if (!lines) {
    throw new Error(
      `found ${tables.length} tables, none starting with the "${PRIVACY_LABEL_COLUMNS[0]}" column`,
    );
  }
  if (lines.length < 3) throw new Error("the privacy label table has no rows");

  const header = cells(lines[0]);
  if (
    header.length !== PRIVACY_LABEL_COLUMNS.length ||
    header.some((name, index) => name !== PRIVACY_LABEL_COLUMNS[index])
  ) {
    throw new Error(
      `table columns are ${JSON.stringify(header)}, expected ${JSON.stringify(PRIVACY_LABEL_COLUMNS)}`,
    );
  }

  return lines.slice(2).map((line) => {
    const row = cells(line);
    if (row.length !== PRIVACY_LABEL_COLUMNS.length) {
      throw new Error(
        `row "${line}" has ${row.length} cells, expected ${PRIVACY_LABEL_COLUMNS.length}`,
      );
    }
    return {
      dataType: row[0],
      collected: row[1],
      purpose: row[2],
      linkedToUser: row[3],
      usedForTracking: row[4],
    };
  });
}

/**
 * Case- and separator-insensitive comparison of a manifest constant's suffix
 * against the name a human types into App Store Connect.
 *
 * This is the one place the two vocabularies are bridged, and it is mechanical
 * on purpose: Apple's constants spell the App Store Connect name with the
 * spaces removed, so folding both sides to letters and digits is enough. It
 * deliberately does not split on capitals, because
 * `NSPrivacyCollectedDataTypePhotosorVideos` spells the "or" in lower case and
 * a capital-splitting rule would derive "Photosor Videos" from it.
 */
function foldForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function labelNamesManifestKey(
  label: string,
  manifestKey: string,
): boolean {
  if (!manifestKey.startsWith(COLLECTED_TYPE_PREFIX)) return false;
  return (
    foldForComparison(label) ===
    foldForComparison(manifestKey.slice(COLLECTED_TYPE_PREFIX.length))
  );
}

export function labelNamesPurposeKey(
  label: string,
  purposeKey: string,
): boolean {
  if (!purposeKey.startsWith(PURPOSE_PREFIX)) return false;
  return (
    foldForComparison(label) ===
    foldForComparison(purposeKey.slice(PURPOSE_PREFIX.length))
  );
}
