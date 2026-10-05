#!/usr/bin/env node
/**
 * Generate a real thumbnail through the API, using the real prompt.
 *
 * This is the test that matters. Everything up to now has been structure; this
 * is whether the output is actually good enough to ship, judged by looking at
 * it rather than by reading code.
 *
 *   npm run probe:thumbnail -- --headline "Mike Adams on Data Center Dangers!"
 *   npm run probe:thumbnail -- --headline "..." --guest "Mike Adams" --photo ./guest.jpg
 *   npm run probe:thumbnail -- --headline "..." --note "darker, more smoke"
 *   npm run probe:thumbnail -- --headline "..." --square
 *   npm run probe:thumbnail -- --headline "..." --no-logo
 *
 * Writes into ./thumbnails/ so the file is visible in Replit's file tree and
 * can be opened or downloaded directly.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const headline = arg("headline");
if (!headline) {
  console.error('\n  Need a headline:\n    npm run probe:thumbnail -- --headline "Your Title Here"\n');
  process.exit(1);
}

const guestName = arg("guest");
const photoPath = arg("photo");
const note = arg("note");
const square = flag("square");
const useLogo = !flag("no-logo");

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.error("\n  OPENAI_API_KEY is not set in this shell.\n");
  process.exit(1);
}

// Built by the same module the app uses, so this tests the real prompt and not
// a copy of it that can drift.
const { buildMasterPrompt, buildSquarePrompt } = await import(
  "../src/lib/images/artwork-prompt.ts"
);

const logoPath = path.join(process.cwd(), "public", "brand", "prather-point-logo.png");
const hasLogo = useLogo && existsSync(logoPath);
const hasGuestPhoto = !!photoPath && existsSync(photoPath);

if (photoPath && !hasGuestPhoto) {
  console.error(`\n  No file at ${photoPath}\n`);
  process.exit(1);
}

const request = { headline, guestName, hasGuestPhoto, hasLogoReference: hasLogo, note };
const prompt = square ? buildSquarePrompt(request) : buildMasterPrompt(request);
const size = square ? "1024x1024" : "1536x1024";

console.log(`\n  headline : ${headline}`);
console.log(`  variant  : ${square ? "SQUARE (no text)" : "MASTER (logo + headline)"}`);
console.log(`  guest    : ${guestName ?? "none"}${hasGuestPhoto ? " (photo supplied)" : ""}`);
console.log(`  logo ref : ${hasLogo ? "yes" : "no"}`);
if (note) console.log(`  note     : ${note}`);
console.log(`  size     : ${size}\n  generating…\n`);

const started = Date.now();
let res;

// With reference images the edits endpoint is required; without them,
// generations. Passing the logo is what makes the model reproduce the real
// mark rather than inventing something logo-shaped.
if (hasLogo || hasGuestPhoto) {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", "high");
  form.append("n", "1");
  if (hasGuestPhoto) {
    const bytes = readFileSync(photoPath);
    form.append("image[]", new Blob([bytes]), path.basename(photoPath));
  }
  if (hasLogo) {
    form.append("image[]", new Blob([readFileSync(logoPath)]), "prather-point-logo.png");
  }
  res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
} else {
  res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size,
      quality: "high",
      n: 1,
      background: "opaque",
      output_format: "png",
    }),
  });
}

const text = await res.text();
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!res.ok) {
  console.error(`  FAILED ${res.status} after ${seconds}s`);
  try {
    const e = JSON.parse(text).error;
    console.error(`  ${e?.code ?? ""} ${e?.message ?? text.slice(0, 300)}\n`);
  } catch {
    console.error(`  ${text.slice(0, 400)}\n`);
  }
  process.exit(1);
}

const body = JSON.parse(text);
const b64 = body.data?.[0]?.b64_json;
if (!b64) {
  console.error("  No image returned:", JSON.stringify(body).slice(0, 300));
  process.exit(1);
}

mkdirSync("thumbnails", { recursive: true });
const slug = headline
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 48);
const file = `thumbnails/${slug}-${square ? "1024x1024" : "1536x1024"}-${Date.now()}.png`;
const bytes = Buffer.from(b64, "base64");
writeFileSync(file, bytes);

console.log(`  OK in ${seconds}s`);
console.log(`  ${file}  (${Math.round(bytes.length / 1024)} KB)`);
console.log(`  usage: ${JSON.stringify(body.usage ?? {})}`);
console.log(`\n  Open it from Replit's file tree to judge it.\n`);
