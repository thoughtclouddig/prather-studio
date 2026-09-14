/**
 * Normalising what an operator actually has in front of them.
 *
 * Rumble hands out several different strings and calls most of them "key" or
 * "API". They are not interchangeable, and pasting the wrong one produces a
 * confusing failure at a moment when nobody wants to debug a URL. So the input
 * is classified before it is used, and the two credentials that are NOT the
 * Live Stream API are rejected by name.
 *
 * ## The one we want
 *
 * The Live Stream API, generated at rumble.com/account/livestream-api. Rumble's
 * own documentation says "the API URL includes your user UI as well as your
 * live stream key" and "authentication is not required for this version of the
 * API" — the URL *is* the credential. Its shape is:
 *
 *     https://rumble.com/-livestream-api/get-data?key=<key>
 *
 * Because the user id is encoded inside the key, a bare key is sufficient: the
 * URL can be reconstructed from it exactly. That is why this accepts either.
 *
 * ## The ones we must refuse
 *
 * RTMP ingest URL and stream key — from Rumble Studio's "GET THE STREAMER
 * CONFIGURATION" step. These tell an ENCODER where to push video. They return
 * no JSON, they are write-path transport credentials, and they have nothing to
 * do with observing whether a stream is live. Storing one here would leave the
 * observer permanently broken and a live RTMP credential sitting in a field
 * built for a read-only URL.
 */

export const LIVESTREAM_API_BASE = "https://rumble.com/-livestream-api/get-data";

export type RumbleInputKind =
  | { kind: "api-url"; apiUrl: string }
  | { kind: "bare-key"; apiUrl: string }
  | { kind: "rtmp"; reason: string }
  | { kind: "unknown"; reason: string };

/**
 * Work out what was pasted and turn it into a usable API URL.
 *
 * Deliberately permissive about the URL form — Rumble has changed the host and
 * path before, and the real validation is the test request that follows. It is
 * only strict about the two things that are definitely the wrong credential.
 */
export function normalizeRumbleInput(raw: string): RumbleInputKind {
  const value = raw.trim();

  if (!value) {
    return { kind: "unknown", reason: "Nothing was entered." };
  }

  // An RTMP ingest URL is the encoder's destination, not a data source.
  if (/^rtmps?:\/\//i.test(value)) {
    return {
      kind: "rtmp",
      reason:
        "That is an RTMP ingest URL — where your encoder pushes video. It is a " +
        "transport credential and returns no data. The Studio needs the read-only " +
        "Live Stream API URL from rumble.com/account/livestream-api instead.",
    };
  }

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { kind: "unknown", reason: "That does not parse as a URL." };
    }

    // Rumble Studio's own pages are a web app, not the data API.
    if (/\/(live|streams?)\/?$/i.test(url.pathname) && !url.searchParams.get("key")) {
      return {
        kind: "unknown",
        reason:
          `${url.href} looks like a Rumble Studio page rather than the Live Stream ` +
          "API. The API URL is generated at rumble.com/account/livestream-api and " +
          "carries a key= parameter.",
      };
    }

    return { kind: "api-url", apiUrl: url.toString() };
  }

  // A bare key. Rumble encodes the user id inside it, so the URL is
  // reconstructable exactly — there is nothing else to ask the operator for.
  if (/^[A-Za-z0-9_\-.=]{16,}$/.test(value)) {
    return {
      kind: "bare-key",
      apiUrl: `${LIVESTREAM_API_BASE}?key=${encodeURIComponent(value)}`,
    };
  }

  return {
    kind: "unknown",
    reason:
      "That is neither a URL nor something that looks like a Live Stream API key. " +
      "Paste either the whole URL from rumble.com/account/livestream-api, or just " +
      "the key from it.",
  };
}

/** Redact a URL for display or logging. Never shows the key. */
export function describeRumbleUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    const key = url.searchParams.get("key");
    if (key) url.searchParams.set("key", `${key.slice(0, 4)}…${key.slice(-2)}`);
    return url.toString();
  } catch {
    return "(unparseable URL)";
  }
}
