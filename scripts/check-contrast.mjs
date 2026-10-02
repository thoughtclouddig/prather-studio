#!/usr/bin/env node
/**
 * WCAG contrast guard for the Studio palette.
 *
 * Reads the token values straight out of globals.css so it can never drift
 * from what ships, and fails if any foreground drops below AA on the darkest
 * surface it can land on. Run it after touching any colour.
 *
 *   npm run check:contrast
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

const token = (name) => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`Token --color-${name} not found in globals.css`);
  return m[1];
};

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l1, l2] = [luminance(hex(a)), luminance(hex(b))];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["ink-000", "ink-050", "ink-100", "ink-150"].map(token);

/** [token, minimum, why] — 4.5 for text, 3.0 for non-text boundaries. */
const RULES = [
  ["type-hi", 4.5, "primary text"],
  ["type-mid", 4.5, "secondary text"],
  ["type-lo", 4.5, "labels, meta, table headers"],
  ["signal-red", 4.5, "FAILED status text"],
  ["signal-amber", 4.5, "WAITING status text"],
  ["signal-green", 4.5, "PUBLISHED status text"],
  ["signal-blue", 4.5, "READY status text"],
  ["signal-violet", 4.5, "PROCESSING status text"],
  ["ink-400", 3.0, "control edges (WCAG 1.4.11)"],
];

let failed = 0;
console.log("Foreground".padEnd(16) + "worst".padEnd(9) + "min".padEnd(7) + "use");
console.log("-".repeat(64));

for (const [name, min, why] of RULES) {
  const value = token(name);
  const worst = Math.min(...SURFACES.map((s) => ratio(value, s)));
  const ok = worst >= min;
  if (!ok) failed++;
  console.log(
    `${name.padEnd(16)}${worst.toFixed(2).padEnd(9)}${String(min).padEnd(7)}${ok ? "" : "FAIL  "}${why}`,
  );
}

// White on the brand red is its own pair — the red is a fill there, not text.
const onBrand = ratio("#ffffff", token("brand-red"));
console.log(`${"white/brand".padEnd(16)}${onBrand.toFixed(2).padEnd(9)}${"4.5".padEnd(7)}${onBrand >= 4.5 ? "" : "FAIL  "}primary button label`);
if (onBrand < 4.5) failed++;

console.log();
if (failed > 0) {
  console.error(`${failed} contrast failure(s). Fix before shipping.`);
  process.exit(1);
}
console.log("All pairs meet WCAG AA on every surface.");
