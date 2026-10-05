#!/usr/bin/env node
/**
 * Ask the API which sizes it accepts, instead of assuming.
 *
 * Sends a deliberately invalid `size`. The validation error enumerates the
 * valid values, and the request is rejected before any image is generated —
 * so this costs nothing.
 */
const key = process.env.OPENAI_API_KEY?.trim();
if (!key) { console.error("\n  OPENAI_API_KEY not set.\n"); process.exit(1); }

for (const model of ["gpt-image-1", "dall-e-3"]) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "x", size: "1920x1080", n: 1 }),
  });
  const text = await res.text();
  let line = text.slice(0, 300);
  try {
    const e = JSON.parse(text).error;
    if (e?.message) line = e.message;
  } catch { /* keep raw */ }
  console.log(`\n  ${model}  ->  HTTP ${res.status}`);
  console.log(`  ${line}`);
}
console.log("");
