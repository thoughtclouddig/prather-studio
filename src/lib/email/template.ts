/**
 * The briefing email.
 *
 * ## Why this is written the way it is
 *
 * Email HTML is not web HTML. Outlook on Windows renders through Microsoft
 * Word, which has no flexbox, no grid, no `max-width` on a `div`, and no
 * reliable float. Gmail strips `<head>`, which takes the stylesheet with it on
 * some clients but not others. So:
 *
 *  · Layout is TABLES. Not a stylistic choice — a div-based layout collapses to
 *    full bleed in Outlook and the email becomes unreadable at desktop width.
 *  · Every style that matters is INLINE. The `<style>` block carries only the
 *    media queries, which are an enhancement: if a client strips them the email
 *    still renders, just without the mobile adjustments.
 *  · The outer table is 100% wide with a 600px inner table, which is how a
 *    fixed-width email centres without `margin: auto`.
 *  · The button is a table cell with `bgcolor`, not a styled anchor. A CSS
 *    button renders as plain blue text in Outlook.
 *
 * The previous version was not responsive, which on a list that is largely
 * read on phones means most of the audience was pinching to read it.
 *
 * ## Dark mode
 *
 * This email is dark by design, which sidesteps the usual problem: clients that
 * force dark mode invert light emails and produce grey-on-grey. Starting dark
 * means an inversion has nothing to do.
 */

export interface EmailSponsor {
  name: string;
  url: string | null;
  offer: string | null;
}

export interface BriefingEmail {
  /** The chosen subject line. Also the headline at the top of the email. */
  headline: string;
  /** Jeff's brief. Paragraphs separated by blank lines. */
  brief: string;
  /** One topic per line. */
  bullets: string[];
  /** Where "Watch today's briefing" goes. Usually the Rumble URL. */
  watchUrl: string | null;
  /** e.g. "Thursday, October 1" */
  dateLabel: string;
  /** e.g. "2:00 PM ET" */
  airTimeLabel: string;
  credentialLine: string;
  sponsors: EmailSponsor[];
  patreonUrl: string | null;
  signOff?: string | null;
}

/**
 * The font stack.
 *
 * Web fonts do not work in email — Outlook ignores @font-face entirely and
 * Gmail strips it. So this is a system stack, declared on EVERY text element
 * rather than once on the body: clients that reset inherited styles inside
 * tables (Outlook among them) otherwise fall back to Times, which is what the
 * first render of this template did.
 */
const FONT =
  "'Helvetica Neue',Helvetica,Arial,'Segoe UI',Roboto,sans-serif";

const INK = "#0d0d10";
const PANEL = "#15161a";
const RULE = "#2a2c33";
const TEXT = "#e8e9ec";
const MUTED = "#9aa0aa";
const RED = "#c8102e";
const BLUE = "#2f5fa8";

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Paragraphs from blank-line-separated prose. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 18px;font-family:${FONT};font-size:17px;line-height:1.62;color:${TEXT};">${escape(
          p,
        ).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

export function renderBriefingEmail(input: BriefingEmail): string {
  const bullets = input.bullets
    .map(
      (bullet) => `
      <tr>
        <td style="padding:0 0 12px;vertical-align:top;width:18px;">
          <div style="width:7px;height:7px;background:${RED};margin-top:9px;"></div>
        </td>
        <td style="padding:0 0 12px;font-family:${FONT};font-size:16px;line-height:1.5;color:${TEXT};">${escape(
          bullet,
        )}</td>
      </tr>`,
    )
    .join("");

  const sponsors = input.sponsors
    .map((sponsor) => {
      const label = escape(sponsor.name);
      const offer = sponsor.offer ? ` &mdash; ${escape(sponsor.offer)}` : "";
      const inner = `<span style="color:${TEXT};font-weight:600;">${label}</span><span style="color:${MUTED};">${offer}</span>`;
      return `
      <tr>
        <td style="padding:0 0 10px;font-family:${FONT};font-size:15px;line-height:1.45;">
          ${
            sponsor.url
              ? `<a href="${escape(sponsor.url)}" style="text-decoration:none;">${inner}</a>`
              : inner
          }
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="supported-color-schemes" content="dark light" />
<title>${escape(input.headline)}</title>
<!--[if mso]>
<style type="text/css">
  body, table, td, p, a, h1 { font-family: Arial, Helvetica, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  /* Enhancement only. A client that strips this still renders the email —
     it simply keeps the desktop measurements. */
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse !important; }
  a { color:inherit; }

  @media only screen and (max-width:620px) {
    .shell      { width:100% !important; }
    .gutter     { padding-left:20px !important; padding-right:20px !important; }
    .h1         { font-size:26px !important; line-height:1.18 !important; }
    .body-text  { font-size:16px !important; }
    .cta        { display:block !important; width:100% !important; }
    .cta a      { display:block !important; font-size:16px !important; padding:16px 18px !important; }
    .stack      { display:block !important; width:100% !important; }
    .pad-top    { padding-top:26px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${INK};font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(
    input.bullets[0] ?? input.headline,
  )}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK};">
<tr><td align="center" style="padding:28px 12px;">

  <table role="presentation" class="shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${PANEL};border:1px solid ${RULE};">

    <!-- masthead -->
    <tr><td class="gutter" style="padding:26px 34px 18px;border-bottom:1px solid ${RULE};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;width:4px;"><div style="width:4px;height:26px;background:${RED};"></div></td>
        <td style="padding-left:12px;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:0.01em;color:${TEXT};">THE PRATHER POINT</td>
      </tr></table>
      <div style="margin-top:8px;font-family:${FONT};font-size:13px;line-height:1.4;color:${MUTED};">${escape(
        input.credentialLine,
      )}</div>
    </td></tr>

    <!-- date strip -->
    <tr><td class="gutter" style="padding:18px 34px 0;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};">
      <span style="color:${RED};">&#9642;</span> Brief &middot; ${escape(input.dateLabel)}
    </td></tr>

    <!-- headline -->
    <tr><td class="gutter" style="padding:12px 34px 20px;">
      <h1 class="h1" style="margin:0;font-family:${FONT};font-size:31px;line-height:1.14;font-weight:800;letter-spacing:-0.02em;color:${TEXT};">${escape(
        input.headline,
      )}</h1>
    </td></tr>

    <!-- brief -->
    <tr><td class="gutter body-text" style="padding:0 34px 6px;">
      ${paragraphs(input.brief)}
      ${
        input.signOff
          ? `<p style="margin:0 0 4px;font-family:${FONT};font-size:15px;color:${MUTED};">&mdash; ${escape(
              input.signOff,
            )}</p>`
          : ""
      }
    </td></tr>

    <!-- watch button: a table cell with bgcolor, because a CSS button renders
         as plain text in Outlook -->
    ${
      input.watchUrl
        ? `<tr><td class="gutter" style="padding:20px 34px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="cta"><tr>
        <td bgcolor="${RED}" style="background:${RED};">
          <a href="${escape(input.watchUrl)}" style="display:inline-block;font-family:${FONT};padding:15px 30px;font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;">&#9654;&nbsp; Watch today&rsquo;s briefing &mdash; ${escape(
            input.airTimeLabel,
          )}</a>
        </td>
      </tr></table>
    </td></tr>`
        : ""
    }

    <!-- topics -->
    <tr><td class="gutter" style="padding:24px 34px 8px;border-top:1px solid ${RULE};">
      <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};padding-bottom:14px;">On today&rsquo;s briefing</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bullets}</table>
    </td></tr>

    ${
      input.patreonUrl
        ? `<tr><td class="gutter" style="padding:10px 34px 26px;">
      <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.5;color:${MUTED};">Go deeper &mdash; the full deep-dive is on Patreon. <a href="${escape(
        input.patreonUrl,
      )}" style="color:${BLUE};font-weight:600;text-decoration:none;">Join here &rarr;</a></p>
    </td></tr>`
        : ""
    }

    ${
      input.sponsors.length > 0
        ? `<tr><td class="gutter" style="padding:22px 34px 28px;border-top:1px solid ${RULE};">
      <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};padding-bottom:14px;">Today&rsquo;s sponsors</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sponsors}</table>
    </td></tr>`
        : ""
    }

    <tr><td class="gutter" style="padding:20px 34px 28px;border-top:1px solid ${RULE};font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
      You are receiving this because you subscribed at jeffreyprather.com.<br />
      <a href="*|UNSUB|*" style="color:${MUTED};">Unsubscribe</a> &nbsp;&middot;&nbsp; *|LIST:ADDRESSLINE|*
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text alternative. Some clients show it; spam filters all read it. */
export function renderBriefingText(input: BriefingEmail): string {
  const lines = [
    "THE PRATHER POINT",
    input.credentialLine,
    "",
    `BRIEF - ${input.dateLabel}`,
    "",
    input.headline,
    "",
    input.brief,
    "",
  ];

  if (input.signOff) lines.push(`-- ${input.signOff}`, "");
  if (input.watchUrl) {
    lines.push(`WATCH TODAY'S BRIEFING - ${input.airTimeLabel}`, input.watchUrl, "");
  }

  lines.push("ON TODAY'S BRIEFING");
  for (const bullet of input.bullets) lines.push(`  - ${bullet}`);
  lines.push("");

  if (input.patreonUrl) {
    lines.push(`Go deeper - the full deep-dive is on Patreon: ${input.patreonUrl}`, "");
  }

  if (input.sponsors.length > 0) {
    lines.push("TODAY'S SPONSORS");
    for (const sponsor of input.sponsors) {
      lines.push(
        `  - ${sponsor.name}${sponsor.offer ? ` - ${sponsor.offer}` : ""}${
          sponsor.url ? ` ${sponsor.url}` : ""
        }`,
      );
    }
    lines.push("");
  }

  lines.push("Unsubscribe: *|UNSUB|*");
  return lines.join("\n");
}
