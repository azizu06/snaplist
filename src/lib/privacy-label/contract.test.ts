import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  labelNamesManifestKey,
  labelNamesPurposeKey,
  parseCollectedDataTypes,
  parsePrivacyLabelRows,
} from "./contract";

/**
 * `docs/app-store-connect-privacy-label.md` is what a human copies into Apple's
 * App Privacy form. `ios/SnapList/PrivacyInfo.xcprivacy` is what the same
 * declaration looks like to the build. Only the manifest is enforced by a
 * toolchain, so the doc is the side that drifts — and the cost of the drift is
 * a submitted label that under-declares, which Apple catches after the
 * submission rather than before it (#953).
 *
 * These assertions derive every answer from the manifest. A new collected type
 * fails here until the doc gains its row; a row the manifest does not declare
 * fails too, because over-declaring is also a wrong label.
 */
const manifest = parseCollectedDataTypes(
  readFileSync(resolve("ios/SnapList/PrivacyInfo.xcprivacy"), "utf8"),
);
const rows = parsePrivacyLabelRows(
  readFileSync(resolve("docs/app-store-connect-privacy-label.md"), "utf8"),
);

describe("App Store Connect privacy label", () => {
  it("has something on both sides to compare", () => {
    // Guards the guards: an empty manifest would make every per-type loop below
    // pass without comparing anything, and parseCollectedDataTypes returns an
    // empty list for an empty array rather than throwing.
    //
    // The doc side needs no such guard — parsePrivacyLabelRows throws on a table
    // with no rows, so an empty table cannot reach a loop in the first place.
    expect(manifest.length).toBeGreaterThan(0);
  });

  it("carries exactly one row per type the manifest declares", () => {
    for (const declared of manifest) {
      expect(
        rows.filter((row) =>
          labelNamesManifestKey(row.dataType, declared.manifestKey),
        ),
        `${declared.manifestKey} is collected but the doc has no row for it`,
      ).toHaveLength(1);
    }

    for (const row of rows) {
      expect(
        manifest.filter((declared) =>
          labelNamesManifestKey(row.dataType, declared.manifestKey),
        ),
        `"${row.dataType}" is a row the manifest does not declare`,
      ).toHaveLength(1);
    }
  });

  it("answers every column the way the manifest answers it", () => {
    for (const declared of manifest) {
      const row = rows.find((candidate) =>
        labelNamesManifestKey(candidate.dataType, declared.manifestKey),
      );
      expect(row, `${declared.manifestKey} has no row`).toBeDefined();
      if (!row) continue;

      const where = `${declared.manifestKey}`;
      // Presence in NSPrivacyCollectedDataTypes is the declaration of collection.
      expect(row.collected, `${where}: collected`).toBe("Yes");
      expect(row.linkedToUser, `${where}: linked to user`).toBe(
        declared.linkedToUser ? "Yes" : "No",
      );
      expect(row.usedForTracking, `${where}: used for tracking`).toBe(
        declared.usedForTracking ? "Yes" : "No",
      );

      const purposes = row.purpose
        .split(",")
        .map((purpose) => purpose.trim())
        .filter(Boolean);
      expect(purposes, `${where}: purposes`).toHaveLength(
        declared.purposeKeys.length,
      );
      declared.purposeKeys.forEach((purposeKey, index) => {
        expect(
          labelNamesPurposeKey(purposes[index], purposeKey),
          `${where}: "${purposes[index]}" does not name ${purposeKey}`,
        ).toBe(true);
      });
    }
  });

  it("names each type the way the form does, not by its manifest constant", () => {
    for (const row of rows) {
      expect(
        row.dataType,
        "the form asks for a data-type name, not a manifest constant",
      ).not.toMatch(/^NSPrivacy/);
    }
  });
});

describe("the manifest and doc parsers", () => {
  const manifestOf = (
    entries: string,
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>NSPrivacyCollectedDataTypes</key><array>${entries}</array></dict></plist>`;

  const emailEntry = `
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
    </dict>`;

  it("reads a complete entry", () => {
    expect(parseCollectedDataTypes(manifestOf(emailEntry))).toEqual([
      {
        manifestKey: "NSPrivacyCollectedDataTypeEmailAddress",
        purposeKeys: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        linkedToUser: true,
        usedForTracking: false,
      },
    ]);
  });

  it("refuses an entry that leaves an App Store Connect question unanswered", () => {
    expect(() =>
      parseCollectedDataTypes(
        manifestOf(
          emailEntry.replace(
            "<key>NSPrivacyCollectedDataTypeTracking</key><false/>",
            "",
          ),
        ),
      ),
    ).toThrow(/NSPrivacyCollectedDataTypeTracking/);
  });

  it("refuses a type declared twice, which would answer one question two ways", () => {
    expect(() =>
      parseCollectedDataTypes(manifestOf(emailEntry + emailEntry)),
    ).toThrow(/declared twice/);
  });

  it("refuses a renamed table column, which would shift every answer silently", () => {
    expect(() =>
      parsePrivacyLabelRows(
        "| Data type | Collected | Purpose | Linked | Used for tracking |\n" +
          "| --- | --- | --- | --- | --- |\n" +
          "| User ID | Yes | Analytics | Yes | No |\n",
      ),
    ).toThrow(/columns/);
  });

  it("treats a manifest constant and the form's name as the same words", () => {
    expect(
      labelNamesManifestKey(
        "Photos or Videos",
        "NSPrivacyCollectedDataTypePhotosorVideos",
      ),
    ).toBe(true);
    expect(
      labelNamesManifestKey(
        "Photo Library",
        "NSPrivacyCollectedDataTypePhotosorVideos",
      ),
    ).toBe(false);
    expect(
      labelNamesPurposeKey(
        "App Functionality",
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      ),
    ).toBe(true);
    expect(
      labelNamesPurposeKey(
        "Analytics",
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      ),
    ).toBe(false);
  });
});
