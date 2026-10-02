/**
 * YouTube (Google) OAuth 2.0 — authorization code flow with offline access.
 *
 * Uses plain fetch rather than googleapis: four endpoints, no SDK needed, and
 * one fewer dependency to keep current.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { YOUTUBE_SCOPES } from "./scopes";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oauthConfig(): OAuthConfig {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are not set. " +
        "Create an OAuth 2.0 Web application client in Google Cloud Console " +
        "and add them to Secrets. See docs/PHASE-2-SETUP.md.",
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri:
      process.env.YOUTUBE_REDIRECT_URI ??
      `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/integrations/youtube/callback`,
  };
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizationUrl(state: string): string {
  const { clientId, redirectUri } = oauthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    // offline + consent is what yields a refresh token. Without `consent`,
    // Google omits the refresh token on re-authorization and the connection
    // silently becomes unrenewable an hour later.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as TokenResponse & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(
      `Google token endpoint returned ${response.status}: ${json.error ?? "unknown"} — ${json.error_description ?? ""}`.trim(),
    );
  }
  return json;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  return postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = oauthConfig();
  return postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  );
}
