import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MARKETING_ROOTS = [
  resolve("src/app/(marketing)"),
  resolve("src/components/marketing"),
];

/** Every literal belongs to the white, ink, blue, or neutral marketing system. */
const APPROVED_MARKETING_TOKENS = new Set([
  "#16181b", "#24262b", "#3a3d44", "#55585c", "#8a8d92", "#c9cdd6",
  "#ffffff", "#f7f7f7", "#ecedef", "#ecedf0", "#eef3ff", "#f6f8ff",
  "#f7f9ff", "#3665f3", "#244cc0", "#3a589e",
]);

/**
 * The phone frame is a drawing of hardware, not part of the marketing color
 * system, so its tones are allowed by name instead of being folded into the
 * palette above. They are the titanium rail gradient, the bezel behind the
 * glass, and the side buttons.
 *
 * Kept separate for two reasons. The palette is a claim about what the page's
 * surfaces, text and actions are made of, and nine greys added to it would
 * quietly stop it being that. And these are confined to the stylesheet that
 * draws the frame, so a component reaching for a device grey is still a
 * violation. They remain subject to the green check like everything else.
 */
// Written without the leading # because this file is itself inside the scanned
// tree, so a literal here would be read as a marketing color and report itself.
// The vendored-wordmark map below dodges the same trap the same way.
const DEVICE_HARDWARE_TONES = new Set(
  [
    "8f9298", "5d6167", "3c4046", "33373c", "5b5f65",
    "05070a", "2f3338", "23262a", "3a3e44",
  ].map((tone) => `#${tone}`),
);

const DEVICE_HARDWARE_FILE = "src/app/(marketing)/marketing.css";

const VENDORED_WORDMARK_COLORS = new Map([
  // Logotyp's supplied Mercari wordmark uses this blue inside its standalone SVG.
  [resolve("public/marketplaces/mercari.svg"), new Set(["#" + "5e6df2"])],
  // Existing WorldVectorLogo Marketplace mark keeps its archive-supplied blue inside its standalone SVG.
  [resolve("public/marketplaces/facebook-marketplace.svg"), new Set(["#" + "3a589e"])],
]);

function marketingSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = resolve(directory, entry);
    if (statSync(file).isDirectory()) return marketingSourceFiles(file);
    return /\.(?:css|tsx?)$/.test(file) ? [file] : [];
  });
}

function isGreenDominant(hex: string): boolean {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return green >= red + 16 && green >= blue + 16;
}

describe("marketing palette", () => {
  it("keeps every marketing hex literal in the approved non-green token palette", () => {
    const violations = marketingSourceFiles(MARKETING_ROOTS[0])
      .concat(marketingSourceFiles(MARKETING_ROOTS[1]))
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/#[0-9a-f]{6}\b/gi)]
        .map((match) => ({ file: relative(process.cwd(), file), hex: match[0].toLowerCase() })))
      .filter(({ file, hex }) => {
        const allowed =
          APPROVED_MARKETING_TOKENS.has(hex) ||
          (file === DEVICE_HARDWARE_FILE && DEVICE_HARDWARE_TONES.has(hex));
        return !allowed || isGreenDominant(hex);
      });

    expect(violations).toEqual([]);
  });

  it("confines vendored marketplace brand colors to their file-specific allowlists", () => {
    for (const [file, allowedColors] of VENDORED_WORDMARK_COLORS) {
      const colors = [...readFileSync(file, "utf8").matchAll(/#[0-9a-f]{6}\b/gi)]
        .map((match) => match[0].toLowerCase());

      expect(colors, relative(process.cwd(), file)).not.toEqual([]);
      expect(colors.every((color) => allowedColors.has(color))).toBe(true);
    }
  });
});
