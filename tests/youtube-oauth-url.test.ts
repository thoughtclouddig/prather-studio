import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizationUrl } from "@/lib/integrations/youtube/oauth";

const KEYS = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "APP_BASE_URL", "REPLIT_DOMAINS"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.YOUTUBE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.YOUTUBE_CLIENT_SECRET = "test-secret";
  process.env.APP_BASE_URL = "https://studio.example.com";
  delete process.env.REPLIT_DOMAINS;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const params = () => new URL(authorizationUrl("state-123")).searchParams;

describe("the authorization request", () => {
  /**
   * The first real connection attached the operator's OWN YouTube channel.
   * Google reused the session already signed in and never offered a choice,
   * so the connection SUCCEEDED against the wrong channel — a failure that
   * only surfaced later, when video matching returned somebody else's uploads.
   */
  it("forces the account chooser so the wrong channel cannot be attached silently", () => {
    expect(params().get("prompt")).toContain("select_account");
  });

  /** Without `consent` Google omits the refresh token on re-authorization. */
  it("still asks for consent, which is what yields a refresh token", () => {
    expect(params().get("prompt")).toContain("consent");
    expect(params().get("access_type")).toBe("offline");
  });

  it("requests exactly the two scopes, and never upload", () => {
    const scope = params().get("scope") ?? "";
    expect(scope).toContain("youtube.force-ssl");
    expect(scope).toContain("yt-analytics.readonly");
    expect(scope).not.toContain("youtube.upload");
  });

  it("sends a redirect_uri with no whitespace", () => {
    const redirect = params().get("redirect_uri") ?? "";
    expect(redirect).toBe("https://studio.example.com/api/integrations/youtube/callback");
    expect(redirect).not.toMatch(/\s/);
  });

  it("carries the state through", () => {
    expect(params().get("state")).toBe("state-123");
    expect(params().get("response_type")).toBe("code");
  });
});
