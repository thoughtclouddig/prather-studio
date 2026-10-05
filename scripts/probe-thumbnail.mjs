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
 *   npm run probe:thumbnail -- --headline "..." --logo        (pass the logo as a reference)
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
// The logo is NOT passed as a reference by default. The working ChatGPT
// process renders it from the written description alone, and a reference image
// pulls the model toward reproducing the reference rather than composing the
// scene. --logo opts in for comparison.
const useLogo = flag("logo");

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

// The style reference is the missing piece, and the operator said so early:
// "based off an example reference thumbnail that we created that it mirrors
// every time". ChatGPT has previous thumbnails sitting in the conversation and
// is doing style transfer from a real example. An API call has only prose
// describing a style, which is why the first results were nothing like the
// weekly ones. Passing a known-good thumbnail closes that gap.
const referencePath = arg(
  "reference",
  path.join(process.cwd(), "public", "brand", "reference-thumbnail.jpg"),
);
const hasReference = !flag("no-reference") && existsSync(referencePath);
const hasGuestPhoto = !!photoPath && existsSync(photoPath);

if (photoPath && !hasGuestPhoto) {
  console.error(`\n  No file at ${photoPath}\n`);
  process.exit(1);
}

const request = { headline, guestName, hasGuestPhoto, hasLogoReference: hasLogo, hasStyleReference: hasReference, note };
const prompt = square ? buildSquarePrompt(request) : buildMasterPrompt(request);
const size = square ? "1024x1024" : "1536x1024";

console.log(`\n  headline : ${headline}`);
console.log(`  variant  : ${square ? "SQUARE (no text)" : "MASTER (logo + headline)"}`);
console.log(`  guest    : ${guestName ?? "none"}${hasGuestPhoto ? " (photo supplied)" : ""}`);
console.log(`  logo ref : ${hasLogo ? "yes" : "no"}`);
console.log(`  style ref: ${hasReference ? path.basename(referencePath) : "NONE"}`);
if (note) console.log(`  note     : ${note}`);
console.log(`  size     : ${size}\n  generating…\n`);

const started = Date.now();
let res;

// With reference images the edits endpoint is required; without them,
// generations. Passing the logo is what makes the model reproduce the real
// mark rather than inventing something logo-shaped.
if (hasLogo || hasGuestPhoto || hasReference) {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", "high");
  form.append("n", "1");
  // The Blob MUST carry a type. Without it the browser-standard default is
  // application/octet-stream, which the API rejects outright — and the error
  // names the file index rather than the cause, so it reads like a bad file.
  const mimeOf = (file) =>
    /\.png$/i.test(file) ? "image/png"
    : /\.webp$/i.test(file) ? "image/webp"
    : "image/jpeg";

  if (hasGuestPhoto) {
    const bytes = readFileSync(photoPath);
    form.append(
      "image[]",
      new Blob([bytes], { type: mimeOf(photoPath) }),
      path.basename(photoPath),
    );
  }
  if (hasLogo) {
    form.append(
      "image[]",
      new Blob([readFileSync(logoPath)], { type: "image/png" }),
      "prather-point-logo.png",
    );
  }
  // Last, so it reads as the style exemplar rather than the subject.
  if (hasReference) {
    form.append(
      "image[]",
      new Blob([readFileSync(referencePath)], { type: mimeOf(referencePath) }),
      path.basename(referencePath),
    );
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

// Fit to the exact delivered size, which is the thing the platforms demand and
// the model cannot render directly.
const { fitMaster, fitSquare, describe } = await import("../src/lib/images/fit.ts");
const raw = Buffer.from(b64, "base64");
const fitted = square ? await fitSquare(raw) : await fitMaster(raw);

mkdirSync("thumbnails", { recursive: true });
const slug = headline
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 48);
const stamp = Date.now();
const rawFile = `thumbnails/${slug}-RAW-${stamp}.png`;
const outFile = `thumbnails/${slug}-${fitted.width}x${fitted.height}-${stamp}.jpg`;
writeFileSync(rawFile, raw);
writeFileSync(outFile, fitted.bytes);

const rawInfo = await describe(raw);

console.log(`  OK in ${seconds}s`);
console.log(`  raw      ${rawInfo.width}x${rawInfo.height}  ${Math.round(raw.length / 1024)} KB  ${rawFile}`);
console.log(`  DELIVERED ${fitted.width}x${fitted.height}  ${Math.round(fitted.bytes.length / 1024)} KB  @q${fitted.quality}  ${outFile}`);
console.log(`  usage: ${JSON.stringify(body.usage ?? {})}`);
console.log(`\n  Open the DELIVERED file from Replit's file tree — that is what ships.\n`);
