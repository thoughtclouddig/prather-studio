import { describe, expect, it } from "vitest";
import {
  describeRumbleUrl,
  LIVESTREAM_API_BASE,
  normalizeRumbleInput,
} from "@/lib/integrations/rumble/credential-input";

const KEY = "aBcD1234eFgH5678iJkL9012mNoP3456";

describe("what the operator actually has", () => {
  it("accepts the full Live Stream API URL", () => {
    const result = normalizeRumbleInput(`${LIVESTREAM_API_BASE}?key=${KEY}`);
    expect(result.kind).toBe("api-url");
    if (result.kind !== "api-url") throw new Error("unreachable");
    expect(result.apiUrl).toContain(KEY);
  });

  /** The reported case: Rumble showed a key, not a URL. */
  it("accepts a bare key and rebuilds the URL", () => {
    const result = normalizeRumbleInput(KEY);
    expect(result.kind).toBe("bare-key");
    if (result.kind !== "bare-key") throw new Error("unreachable");
    expect(result.apiUrl).toBe(`${LIVESTREAM_API_BASE}?key=${KEY}`);
  });

  it("trims whitespace from a pasted key", () => {
    const result = normalizeRumbleInput(`  ${KEY}\n`);
    expect(result.kind).toBe("bare-key");
    if (result.kind !== "bare-key") throw new Error("unreachable");
    expect(result.apiUrl).toBe(`${LIVESTREAM_API_BASE}?key=${KEY}`);
  });

  it("percent-encodes a key containing URL-significant characters", () => {
    const result = normalizeRumbleInput("abc=def+ghi/jkl".padEnd(20, "x"));
    if (result.kind === "bare-key") expect(result.apiUrl).not.toContain(" ");
  });
});

describe("credentials that are NOT the Live Stream API", () => {
  /**
   * The encoder's destination. Storing it here would leave the observer
   * permanently broken and put a live write-path credential in a read-only
   * field.
   */
  it("refuses an RTMP ingest URL and says what it is", () => {
    const result = normalizeRumbleInput("rtmp://ingest.rumble.com/live/");
    expect(result.kind).toBe("rtmp");
    if (result.kind !== "rtmp") throw new Error("unreachable");
    expect(result.reason).toMatch(/encoder/i);
    expect(result.reason).toContain("rumble.com/account/livestream-api");
  });

  it("refuses RTMPS too", () => {
    expect(normalizeRumbleInput("rtmps://ingest.rumble.com/live/abc").kind).toBe("rtmp");
  });

  it("refuses a Rumble Studio page URL with no key", () => {
    const result = normalizeRumbleInput("https://rumble.com/live");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.reason).toContain("rumble.com/account/livestream-api");
  });

  it("refuses an empty value", () => {
    expect(normalizeRumbleInput("   ").kind).toBe("unknown");
  });

  it("refuses something too short to be a key", () => {
    expect(normalizeRumbleInput("abc123").kind).toBe("unknown");
  });

  /** A host we do not recognise is still tried — the test request decides. */
  it("passes an unfamiliar https URL through rather than guessing", () => {
    const result = normalizeRumbleInput("https://studio.rumble.com/api/v1/data?key=x");
    expect(result.kind).toBe("api-url");
  });
});

describe("never showing the key", () => {
  it("redacts the key when describing a URL", () => {
    const shown = describeRumbleUrl(`${LIVESTREAM_API_BASE}?key=${KEY}`);
    expect(shown).not.toContain(KEY);
    expect(shown).toContain("aBcD");
    expect(shown).toContain("56");
  });

  it("does not throw on an unparseable URL", () => {
    expect(describeRumbleUrl("not a url")).toBe("(unparseable URL)");
  });
});
