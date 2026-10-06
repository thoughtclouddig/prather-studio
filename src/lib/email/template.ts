/**
 * The briefing email.
 *
 * ## Why this is written the way it is
 *
 * Email HTML is not web HTML. Outlook on Windows renders through Microsoft
 * Word, which has no flexbox, no grid, no `max-width` on a `div`, and no
 * reliable float. Gmail strips `<head>` — and with it the whole stylesheet —
 * when it serves a non-Gmail account. So:
 *
 *  · Layout is TABLES. Not a stylistic choice — a div-based layout collapses
 *    to full bleed in Outlook and the email becomes unreadable.
 *  · Every style that matters is INLINE. The `<style>` block may not arrive.
 *  · The button is a table cell with `bgcolor`, not a styled anchor. A CSS
 *    button renders as plain blue text in Outlook.
 *
 * ## Responsive, without depending on the media query
 *
 * The list is read mostly on phones, and a stylesheet is the first thing an
 * email client throws away. So the layout is fluid rather than switched:
 *
 *  · The shell is `width:100%` with `max-width:600px` — no `width="600"`
 *    attribute anywhere a phone can see it, because a table pinned to 600
 *    pixels cannot shrink and is what forces the sideways scroll. Outlook
 *    cannot do `max-width`, so it gets its 600 from an MSO ghost table.
 *  · The INLINE defaults are the mobile values, and the media query is
 *    `min-width` — it widens. The usual `max-width` arrangement fails the
 *    wrong way: strip the CSS and you serve the desktop layout to a phone.
 *    This way, stripping it serves a narrow layout to a desktop, which is
 *    merely plain. The worse failure should be the impossible one.
 *  · The button is full width by default, so the tap target survives with no
 *    CSS at all.
 *
 * Outlook ignores media queries entirely, so the desktop values are repeated
 * in an MSO conditional block rather than left to chance.
 *
 * ## Colour
 *
 * Light: a white card on a light grey page. Both the background AND the text
 * colour are declared on every element — an email that sets one and inherits
 * the other is the one that turns white-on-white the day a client themes it.
 * `color-scheme: light` tells Apple Mail and Outlook not to apply their own
 * dark transform over decisions already made here.
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

/* ----------------------------------------------------------------- colour

   Light. The card is white, the page behind it a light grey so the card has
   an edge in clients that show the surrounding area.

   Every value below is declared explicitly on the element that uses it. An
   email that declares a background but inherits its text colour is the one
   that turns white-on-white the day a client decides to theme it. */
const PAGE = "#ececed";
const PANEL = "#ffffff";
const RULE = "#dcdce1";
const TEXT = "#16161a";
const MUTED = "#585e68";
const RED = "#c8102e";
const BLUE = "#1f4f96";

/* ------------------------------------------------------------- measurement

   Mobile values are the DEFAULTS, inline on each element. Desktop values are
   applied by a min-width media query and, separately, by an MSO conditional
   block.

   This is the opposite of the usual max-width approach, and deliberately so.
   A media query is the first thing an email client strips — Gmail serving a
   non-Gmail account drops the <style> block wholesale. Under a max-width
   architecture that failure renders the DESKTOP layout on a phone: 34px
   gutters and a 31px headline on a 320px screen. Under this one it renders
   the MOBILE layout on a desktop, which is merely narrow. The worse failure
   is the one that should be impossible, so the safe values are the ones that
   survive without CSS. */
const GUTTER = "20px";
const GUTTER_WIDE = "34px";

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
        `<p class="body-text" style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:1.62;color:${TEXT};">${escape(
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
          <div style="width:7px;height:7px;background:${RED};margin-top:8px;font-size:0;line-height:0;">&nbsp;</div>
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
        <td style="padding:0 0 10px;font-family:${FONT};font-size:15px;line-height:1.45;color:${TEXT};">
          ${
            sponsor.url
              ? `<a href="${escape(sponsor.url)}" style="text-decoration:none;color:${TEXT};">${inner}</a>`
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
<!-- Light only. Without this, Apple Mail and Outlook apply their own dark
     transform and re-colour declared values; saying the email supports only
     light stops them re-deciding what is already decided here. -->
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escape(input.headline)}</title>
<!--[if mso]>
<style type="text/css">
  body, table, td, p, a, h1 { font-family: Arial, Helvetica, sans-serif !important; }
  /* Outlook ignores media queries, so it never sees the desktop rules below.
     It is always a wide client, so it gets the wide values here instead. */
  .gutter    { padding-left:34px !important; padding-right:34px !important; }
  .h1        { font-size:31px !important; }
  .body-text { font-size:17px !important; }
</style>
<![endif]-->
<style type="text/css">
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse !important; }
  a { color:inherit; }

  /* Enhancement. Everything below widens an already-correct mobile layout;
     a client that strips this renders a narrower email, never a broken one. */
  @media screen and (min-width:621px) {
    .gutter    { padding-left:${GUTTER_WIDE} !important; padding-right:${GUTTER_WIDE} !important; }
    .h1        { font-size:31px !important; line-height:1.14 !important; }
    .body-text { font-size:17px !important; }
    .cta       { width:auto !important; }
    .cta a     { display:inline-block !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};font-family:${FONT};color:${TEXT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(
    input.bullets[0] ?? input.headline,
  )}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
<tr><td align="center" style="padding:24px 10px;">

  <!--[if mso]>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td>
  <![endif]-->

  <!-- Fluid to the viewport, capped at 600. Deliberately no fixed width
       attribute: a table pinned to 600 pixels cannot shrink, and on a 320px
       screen it is exactly what forces the sideways scroll. Outlook, which
       cannot do max-width, takes its 600 from the ghost table above. -->
  <div class="shell" style="width:100%;max-width:600px;margin:0 auto;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${PANEL};border:1px solid ${RULE};">

    <!-- masthead -->
    <tr><td class="gutter" style="padding:24px ${GUTTER} 16px;border-bottom:1px solid ${RULE};background:${PANEL};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;width:4px;"><div style="width:4px;height:26px;background:${RED};font-size:0;line-height:0;">&nbsp;</div></td>
        <td style="padding-left:12px;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:0.01em;color:${TEXT};">THE PRATHER POINT</td>
      </tr></table>
      <div style="margin-top:8px;font-family:${FONT};font-size:13px;line-height:1.4;color:${MUTED};">${escape(
        input.credentialLine,
      )}</div>
    </td></tr>

    <!-- date strip -->
    <tr><td class="gutter" style="padding:18px ${GUTTER} 0;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};background:${PANEL};">
      <span style="color:${RED};">&#9642;</span> Brief &middot; ${escape(input.dateLabel)}
    </td></tr>

    <!-- headline -->
    <tr><td class="gutter" style="padding:12px ${GUTTER} 20px;background:${PANEL};">
      <h1 class="h1" style="margin:0;font-family:${FONT};font-size:26px;line-height:1.18;font-weight:800;letter-spacing:-0.02em;color:${TEXT};">${escape(
        input.headline,
      )}</h1>
    </td></tr>

    <!-- brief -->
    <tr><td class="gutter" style="padding:0 ${GUTTER} 6px;background:${PANEL};">
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
         as plain text in Outlook. Full width by default so a thumb can hit it
         without the media query having survived. -->
    ${
      input.watchUrl
        ? `<tr><td class="gutter" style="padding:20px ${GUTTER} 26px;background:${PANEL};">
      <table role="presentation" class="cta" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
        <td bgcolor="${RED}" align="center" style="background:${RED};">
          <a href="${escape(input.watchUrl)}" style="display:block;font-family:${FONT};padding:15px 24px;font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;">&#9654;&nbsp; Watch today&rsquo;s briefing &mdash; ${escape(
            input.airTimeLabel,
          )}</a>
        </td>
      </tr></table>
    </td></tr>`
        : ""
    }

    <!-- topics -->
    <tr><td class="gutter" style="padding:24px ${GUTTER} 8px;border-top:1px solid ${RULE};background:${PANEL};">
      <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};padding-bottom:14px;">On today&rsquo;s briefing</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bullets}</table>
    </td></tr>

    ${
      input.patreonUrl
        ? `<tr><td class="gutter" style="padding:10px ${GUTTER} 26px;background:${PANEL};">
      <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.5;color:${MUTED};">Go deeper &mdash; the full deep-dive is on Patreon. <a href="${escape(
        input.patreonUrl,
      )}" style="color:${BLUE};font-weight:600;text-decoration:none;">Join here &rarr;</a></p>
    </td></tr>`
        : ""
    }

    ${
      input.sponsors.length > 0
        ? `<tr><td class="gutter" style="padding:22px ${GUTTER} 28px;border-top:1px solid ${RULE};background:${PANEL};">
      <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};padding-bottom:14px;">Today&rsquo;s sponsors</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sponsors}</table>
    </td></tr>`
        : ""
    }

    <tr><td class="gutter" style="padding:20px ${GUTTER} 28px;border-top:1px solid ${RULE};font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};background:${PANEL};">
      You are receiving this because you subscribed at jeffreyprather.com.<br />
      <a href="*|UNSUB|*" style="color:${MUTED};">Unsubscribe</a> &nbsp;&middot;&nbsp; *|LIST:ADDRESSLINE|*
    </td></tr>

  </table>
  </div>

  <!--[if mso]>
  </td></tr></table>
  <![endif]-->

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
