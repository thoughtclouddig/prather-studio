#!/usr/bin/env node
/**
 * Verify image generation works against the real account, cheaply.
 *
 * Run once after adding OPENAI_API_KEY. Generates ONE low-quality image, which
 * is the cheapest tier, and reports exactly what came back. Worth doing before
 * anything is built on top: gpt-image-1 requires a verified OpenAI
 * organisation, and that failure reports as a generic error that sends people
 * looking in the code rather than at their account settings.
 */
const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.error("\n  OPENAI_API_KEY is not set in this shell.\n");
  process.exit(1);
}
console.log(`\n  key: ${key.slice(0, 7)}…${key.slice(-4)} (${key.length} chars)\n`);

const started = Date.now();
const res = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "gpt-image-1",
    prompt:
      "A single dramatic storm cloud over a dark horizon, cinematic, high contrast. " +
      "ABSOLUTELY NO TEXT of any kind anywhere in the image.",
    size: "1536x1024",
    quality: "low",
    n: 1,
    background: "opaque",
    output_format: "png",
  }),
});

const text = await res.text();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`  status : ${res.status}   (${seconds}s)`);

try {
  const body = JSON.parse(text);
  if (body.data?.[0]?.b64_json) {
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    console.log(`  bytes  : ${Math.round(bytes.length / 1024)} KB`);
    console.log(`  usage  : ${JSON.stringify(body.usage ?? {})}`);
    console.log("\n  WORKS. gpt-image-1 is available on this account.\n");
  } else if (body.error) {
    console.log(`  code   : ${body.error.code ?? "—"}`);
    console.log(`  message: ${body.error.message}`);
    if (/verif/i.test(body.error.message ?? "")) {
      console.log(
        "\n  This is an ACCOUNT setting, not a code problem: gpt-image-1 needs a\n" +
          "  verified organisation. platform.openai.com/settings/organization/general\n",
      );
    } else {
      console.log("");
    }
  } else {
    console.log("  body   :", JSON.stringify(body).slice(0, 400));
  }
} catch {
  console.log("  raw    :", text.slice(0, 400));
}
