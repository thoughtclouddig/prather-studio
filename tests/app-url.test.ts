import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appBaseUrl, youtubeRedirectUri } from "@/lib/app-url";

const KEYS = ["APP_BASE_URL", "REPLIT_DOMAINS", "REPLIT_DEV_DOMAIN", "YOUTUBE_REDIRECT_URI"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolution order", () => {
  it("prefers an explicit APP_BASE_URL over everything", () => {
    process.env.APP_BASE_URL = "https://studio.jeffreyprather.com";
    process.env.REPLIT_DOMAINS = "ignored.replit.dev";
    expect(appBaseUrl()).toBe("https://studio.jeffreyprather.com");
  });

  /** The reported case: a workspace where APP_BASE_URL was never set. */
  it("derives the host from REPLIT_DOMAINS when APP_BASE_URL is absent", () => {
    process.env.REPLIT_DOMAINS = "abc-00-xyz.riker.replit.dev";
    expect(appBaseUrl()).toBe("https://abc-00-xyz.riker.replit.dev");
  });

  it("takes the first entry of a comma-separated REPLIT_DOMAINS", () => {
    process.env.REPLIT_DOMAINS = "first.replit.app,second.replit.dev";
    expect(appBaseUrl()).toBe("https://first.replit.app");
  });

  it("falls back to REPLIT_DEV_DOMAIN", () => {
    process.env.REPLIT_DEV_DOMAIN = "dev.riker.replit.dev";
    expect(appBaseUrl()).toBe("https://dev.riker.replit.dev");
  });

  it("falls back to localhost for local development", () => {
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it("ignores a blank APP_BASE_URL rather than producing an empty origin", () => {
    process.env.APP_BASE_URL = "   ";
    process.env.REPLIT_DOMAINS = "fallback.replit.dev";
    expect(appBaseUrl()).toBe("https://fallback.replit.dev");
  });
});

/**
 * Both of these produce a redirect_uri_mismatch at Google, which fails before
 * the request reaches us and leaves nothing in our logs to explain it.
 */
describe("the two mistakes that break OAuth invisibly", () => {
  it("strips a trailing slash", () => {
    process.env.APP_BASE_URL = "https://studio.replit.app/";
    expect(appBaseUrl()).toBe("https://studio.replit.app");
    expect(youtubeRedirectUri()).toBe(
      "https://studio.replit.app/api/integrations/youtube/callback",
    );
  });

  it("strips several trailing slashes", () => {
    process.env.APP_BASE_URL = "https://studio.replit.app///";
    expect(appBaseUrl()).toBe("https://studio.replit.app");
  });

  it("adds https to a bare host", () => {
    process.env.APP_BASE_URL = "studio.replit.app";
    expect(appBaseUrl()).toBe("https://studio.replit.app");
  });

  it("leaves an explicit http scheme alone", () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });
});

describe("redirect uri", () => {
  it("is the base plus the callback path", () => {
    process.env.APP_BASE_URL = "https://studio.replit.app";
    expect(youtubeRedirectUri()).toBe(
      "https://studio.replit.app/api/integrations/youtube/callback",
    );
  });

  it("honours an explicit override for a proxy or custom domain", () => {
    process.env.APP_BASE_URL = "https://studio.replit.app";
    process.env.YOUTUBE_REDIRECT_URI = "https://custom.example/oauth/cb";
    expect(youtubeRedirectUri()).toBe("https://custom.example/oauth/cb");
  });

  it("derives from the Replit domain with nothing configured at all", () => {
    process.env.REPLIT_DOMAINS = "abc.riker.replit.dev";
    expect(youtubeRedirectUri()).toBe(
      "https://abc.riker.replit.dev/api/integrations/youtube/callback",
    );
  });
});
