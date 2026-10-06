/**
 * Mailchimp Marketing API client.
 *
 * ## The datacenter is in the key
 *
 * A Mailchimp key ends in `-us21`, `-us14` and so on, and that suffix IS the
 * API host. There is no single endpoint: calling the wrong datacenter returns
 * 401 as though the key were invalid, which sends people to regenerate a key
 * that was fine. So the host is derived from the key rather than configured.
 *
 * ## What this does and does not do
 *
 * It creates a DRAFT campaign, sets its content, and — only when explicitly
 * asked — schedules it. It never sends immediately. Mailchimp has no undo: a
 * campaign that has gone out has gone out, to the whole list, and that is the
 * one irreversible action in this entire system.
 *
 * ## Scheduling is on a 15-minute grid
 *
 * Mailchimp rejects a `schedule_time` that is not on a quarter hour. 12:45 PM
 * MST happens to be valid; 12:50 would be refused with an error that does not
 * mention the grid. The schedule helper rounds and says it did.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

export interface MailchimpCredentialPayload {
  apiKey: string;
  /** The audience the briefing goes to. */
  listId: string;
  /** Derived from the key, stored so it is visible rather than recomputed. */
  datacenter: string;
}

export class MailchimpApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "MailchimpApiError";
  }
}

export class MailchimpNotConnectedError extends Error {
  constructor() {
    super("Mailchimp is not connected. Add the API key in Integrations.");
    this.name = "MailchimpNotConnectedError";
  }
}

/** `abc123...-us21` → `us21`. The suffix is the API host. */
export function datacenterFromKey(apiKey: string): string | null {
  const match = /-([a-z]{2}\d{1,3})$/i.exec(apiKey.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

async function credential(): Promise<MailchimpCredentialPayload> {
  const stored = await readCredential<MailchimpCredentialPayload>("MAILCHIMP");
  if (!stored) throw new MailchimpNotConnectedError();
  return stored.payload;
}

async function call<T>(
  path: string,
  c: MailchimpCredentialPayload,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`https://${c.datacenter}.api.mailchimp.com/3.0${path}`, {
    method: init.method ?? "GET",
    headers: {
      // "anystring" is Mailchimp's documented username for key auth.
      authorization: `Basic ${Buffer.from(`anystring:${c.apiKey}`).toString("base64")}`,
      "content-type": "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { detail?: string; title?: string; errors?: unknown };
      detail = parsed.detail ?? parsed.title ?? detail;
    } catch {
      /* keep the raw body */
    }
    throw new MailchimpApiError(
      res.status,
      detail,
      res.status === 401
        ? "Mailchimp rejected the API key."
        : `Mailchimp returned ${res.status}: ${detail}`,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface MailchimpAudience {
  id: string;
  name: string;
  memberCount: number;
}

export interface MailchimpAccount {
  accountName: string;
  email: string;
  audiences: MailchimpAudience[];
}

/**
 * Verify a key and report what it reaches.
 *
 * Lists the audiences so an operator picks one rather than pasting an id —
 * a wrong list id is a briefing sent to the wrong people, and Mailchimp will
 * not tell you it was wrong, only that it worked.
 */
export async function verifyKey(apiKey: string): Promise<MailchimpAccount> {
  const datacenter = datacenterFromKey(apiKey);
  if (!datacenter) {
    throw new Error(
      "That does not look like a Mailchimp API key. A key ends with its " +
        "datacenter, for example -us21.",
    );
  }

  const c: MailchimpCredentialPayload = { apiKey, listId: "", datacenter };

  const root = await call<{ account_name?: string; email?: string }>("/", c);
  const lists = await call<{
    lists?: Array<{ id: string; name: string; stats?: { member_count?: number } }>;
  }>("/lists?count=50&fields=lists.id,lists.name,lists.stats.member_count", c);

  return {
    accountName: root.account_name ?? "",
    email: root.email ?? "",
    audiences: (lists.lists ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      memberCount: l.stats?.member_count ?? 0,
    })),
  };
}

export interface CampaignSettings {
  subjectLine: string;
  previewText: string;
  /** Internal name in Mailchimp's list. Never seen by a subscriber. */
  title: string;
  fromName: string;
  replyTo: string;
}

export interface MailchimpCampaign {
  id: string;
  webId: number | null;
  status: string;
  archiveUrl: string | null;
}

/** Create the campaign as a draft. */
export async function createCampaign(
  settings: CampaignSettings,
): Promise<MailchimpCampaign> {
  const c = await credential();
  const data = await call<Record<string, unknown>>("/campaigns", c, {
    method: "POST",
    body: {
      type: "regular",
      recipients: { list_id: c.listId },
      settings: {
        subject_line: settings.subjectLine,
        preview_text: settings.previewText,
        title: settings.title,
        from_name: settings.fromName,
        reply_to: settings.replyTo,
        auto_footer: false,
        inline_css: true,
      },
    },
  });

  return {
    id: String(data["id"]),
    webId: typeof data["web_id"] === "number" ? data["web_id"] : null,
    status: String(data["status"] ?? "save"),
    archiveUrl: typeof data["archive_url"] === "string" ? data["archive_url"] : null,
  };
}

/** Set the campaign's HTML and plain-text content. */
export async function setCampaignContent(
  campaignId: string,
  html: string,
  plainText: string,
): Promise<void> {
  const c = await credential();
  await call(`/campaigns/${campaignId}/content`, c, {
    method: "PUT",
    body: { html, plain_text: plainText },
  });
}

/** Update a draft's subject or preview text without recreating it. */
export async function updateCampaignSettings(
  campaignId: string,
  settings: Partial<CampaignSettings>,
): Promise<void> {
  const c = await credential();
  await call(`/campaigns/${campaignId}`, c, {
    method: "PATCH",
    body: {
      settings: {
        ...(settings.subjectLine ? { subject_line: settings.subjectLine } : {}),
        ...(settings.previewText ? { preview_text: settings.previewText } : {}),
        ...(settings.title ? { title: settings.title } : {}),
      },
    },
  });
}

/**
 * Round up to Mailchimp's 15-minute grid.
 *
 * A `schedule_time` off the quarter hour is refused, and the error does not
 * mention the grid — so this rounds rather than failing, and the caller reports
 * the time actually used.
 */
export function roundToQuarterHour(when: Date): Date {
  const rounded = new Date(when);
  rounded.setSeconds(0, 0);
  const remainder = rounded.getMinutes() % 15;
  if (remainder !== 0) rounded.setMinutes(rounded.getMinutes() + (15 - remainder));
  return rounded;
}

/**
 * Schedule the campaign.
 *
 * The only call in this client that causes anything to reach a subscriber, and
 * it still does not send now — Mailchimp has no undo, and a briefing that has
 * gone out has gone out to the whole list.
 */
export async function scheduleCampaign(
  campaignId: string,
  when: Date,
): Promise<{ scheduledFor: Date }> {
  const c = await credential();
  const scheduledFor = roundToQuarterHour(when);

  if (scheduledFor.getTime() <= Date.now()) {
    throw new Error(
      `That send time (${scheduledFor.toISOString()}) is in the past. Pick a later one.`,
    );
  }

  await call(`/campaigns/${campaignId}/actions/schedule`, c, {
    method: "POST",
    body: { schedule_time: scheduledFor.toISOString() },
  });

  return { scheduledFor };
}

/** Read a campaign back, so the Studio shows Mailchimp's state, not its own. */
export async function getCampaign(campaignId: string): Promise<MailchimpCampaign | null> {
  const c = await credential();
  try {
    const data = await call<Record<string, unknown>>(`/campaigns/${campaignId}`, c);
    return {
      id: String(data["id"]),
      webId: typeof data["web_id"] === "number" ? data["web_id"] : null,
      status: String(data["status"] ?? ""),
      archiveUrl: typeof data["archive_url"] === "string" ? data["archive_url"] : null,
    };
  } catch (error) {
    if (error instanceof MailchimpApiError && error.status === 404) return null;
    throw error;
  }
}
