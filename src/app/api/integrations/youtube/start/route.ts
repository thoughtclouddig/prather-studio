/**
 * Begin the YouTube OAuth flow.
 *
 * The CSRF state is stored in an httpOnly cookie and compared on the way back,
 * so a callback the operator did not initiate cannot connect an account.
 */
import { cookies } from "next/headers";
import { appBaseUrl } from "@/lib/app-url";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorize";
import { authorizationUrl, newState } from "@/lib/integrations/youtube/oauth";

export const OAUTH_STATE_COOKIE = "prather_youtube_oauth_state";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", baseUrl()));
  if (!can(user.role, "integration.configure")) {
    return NextResponse.redirect(
      new URL("/studio/integrations?error=Only+an+OWNER+can+connect+integrations", baseUrl()),
    );
  }

  let url: string;
  const state = newState();
  try {
    url = authorizationUrl(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(
      new URL(`/studio/integrations?error=${encodeURIComponent(message)}`, baseUrl()),
    );
  }

  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(url);
}

function baseUrl() {
  return appBaseUrl();
}
