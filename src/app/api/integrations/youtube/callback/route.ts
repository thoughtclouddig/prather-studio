/**
 * YouTube OAuth callback.
 *
 * Verifies the CSRF state, exchanges the code, confirms the granted scopes are
 * the ones we asked for, identifies the channel, and stores the tokens
 * encrypted. Nothing here ever renders a token.
 */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorize";
import { saveCredential } from "@/lib/integrations/credentials";
import { exchangeCode } from "@/lib/integrations/youtube/oauth";
import { YOUTUBE_SCOPES } from "@/lib/integrations/youtube/scopes";
import { getMyChannel } from "@/lib/integrations/youtube/client";
import { OAUTH_STATE_COOKIE } from "../start/route";

function back(message: string, kind: "error" | "ok" = "error") {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return NextResponse.redirect(
    new URL(`/studio/integrations?${kind}=${encodeURIComponent(message)}`, base),
  );
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "integration.configure")) {
    return back("Only a signed-in OWNER can complete this connection.");
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return back(`Google returned: ${params.get("error")}`);
  }

  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);

  if (!expected || params.get("state") !== expected) {
    return back("The authorization state did not match. Start the connection again.");
  }

  const code = params.get("code");
  if (!code) return back("Google did not return an authorization code.");

  try {
    const tokens = await exchangeCode(code);

    // Without a refresh token the connection dies in an hour and cannot renew.
    if (!tokens.refresh_token) {
      return back(
        "Google did not return a refresh token. Remove the Studio at " +
          "myaccount.google.com/permissions and connect again.",
      );
    }

    const granted = tokens.scope.split(" ");
    const missing = YOUTUBE_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      return back(
        `Some scopes were not granted (${missing.join(", ")}). ` +
          "Captions and metadata updates need all of them.",
      );
    }

    await saveCredential({
      provider: "YOUTUBE",
      kind: "OAUTH",
      payload: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType: tokens.token_type,
      },
      scopes: granted,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    // Now that the credential is stored, identify the channel it belongs to.
    const channel = await getMyChannel();
    await saveCredential({
      provider: "YOUTUBE",
      kind: "OAUTH",
      payload: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType: tokens.token_type,
      },
      scopes: granted,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      accountLabel: channel.title,
      accountExternalId: channel.id,
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    return back(`Connected to ${channel.title}.`, "ok");
  } catch (error) {
    return back(error instanceof Error ? error.message : String(error));
  }
}
