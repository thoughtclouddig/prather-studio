/**
 * Resend — transactional mail.
 *
 * Deliberately separate from Mailchimp. Mailchimp sends the briefing to the
 * audience: a campaign, scheduled, irreversible, and the one thing in this
 * system that reaches thousands of people. This sends one line to one
 * operator saying Jeff filled the form in. Running both through the same
 * credential would mean the key that notifies you is also the key that can
 * mail the list.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

const API = "https://api.resend.com";

export interface ResendCredentialPayload {
  apiKey: string;
  /** Verified sender. Resend rejects anything else. */
  from: string;
}

export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResendApiError";
  }
}

export class ResendNotConnectedError extends Error {
  constructor() {
    super(
      "Resend is not connected. Add the API key in Integrations, or set " +
        "RESEND_API_KEY in Secrets.",
    );
    this.name = "ResendNotConnectedError";
  }
}

/**
 * Resolve the credential from the Studio first, then the environment.
 *
 * Most providers here are connected through the Integrations screen, which
 * verifies the key and stores it encrypted. This one also accepts
 * `RESEND_API_KEY` from the environment, because an operator putting a mail
 * key in Replit Secrets is a reasonable thing to do and should not silently
 * do nothing.
 *
 * The stored credential wins when both exist: it is the one that was actually
 * verified, and two sources disagreeing should resolve to the one someone
 * confirmed rather than to whichever was read last.
 */
async function credential(): Promise<ResendCredentialPayload> {
  const stored = await readCredential<ResendCredentialPayload>("RESEND");
  if (stored) return stored.payload;

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new ResendNotConnectedError();

  return {
    apiKey,
    // Resend's shared sender works with no domain setup. A real address
    // belongs in RESEND_FROM once a domain is verified.
    from: process.env.RESEND_FROM?.trim() || "onboarding@resend.dev",
  };
}

/** Whether mail can be sent at all, and how it was configured. */
export async function resendSource(): Promise<"studio" | "environment" | null> {
  if (await readCredential<ResendCredentialPayload>("RESEND")) return "studio";
  return process.env.RESEND_API_KEY?.trim() ? "environment" : null;
}

interface SendResult {
  id: string;
}

async function post(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<SendResult> {
  const res = await fetch(`${API}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: { id?: string; message?: string; name?: string } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* fall through to the status */
  }

  if (!res.ok) {
    throw new ResendApiError(
      res.status,
      res.status === 401
        ? "Resend rejected that API key."
        : res.status === 403
          ? `Resend refused the sender. ${parsed.message ?? "The From address must be a verified domain."}`
          : `Resend returned ${res.status}: ${parsed.message ?? text.slice(0, 200)}`,
    );
  }

  if (!parsed.id) throw new ResendApiError(res.status, "Resend accepted it but returned no id.");
  return { id: parsed.id };
}

export interface Notification {
  to: string;
  subject: string;
  /** Plain text. These are operator notes, not marketing — no HTML needed. */
  text: string;
}

export async function sendNotification(message: Notification): Promise<SendResult> {
  const c = await credential();
  return post(c.apiKey, {
    from: c.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
  });
}

/**
 * Check a key by sending nothing.
 *
 * Resend has no "whoami", so this lists domains — the cheapest authenticated
 * read. Verifying by sending a test email would put a real message in
 * someone's inbox every time a key is pasted.
 */
export async function verifyKey(apiKey: string): Promise<{ domains: string[] }> {
  const res = await fetch(`${API}/domains`, {
    headers: { authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new ResendApiError(
      res.status,
      res.status === 401
        ? "Resend rejected that API key."
        : `Resend returned ${res.status} when checking the key.`,
    );
  }

  const body = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
  return {
    domains: (body.data ?? [])
      .filter((d) => d.status === "verified")
      .map((d) => d.name ?? "")
      .filter(Boolean),
  };
}
