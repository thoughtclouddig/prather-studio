import { describe, expect, it } from "vitest";
import { renderBriefingEmail, renderBriefingText } from "@/lib/email/template";

const email = {
  headline: "The Iraq WMD false flag I activated in 2003 just ended Wednesday",
  brief: "Jeff here. I was there in 2003.\n\nHere's the tell: the timing.",
  bullets: ["Slab and the SEALs slide into scandal", "The Senate refuses to investigate"],
  watchUrl: "https://rumble.com/v7g8rbk-test.html",
  dateLabel: "Thursday, October 1",
  airTimeLabel: "2:00 PM ET",
  credentialLine: "Jeffrey Prather · MAJ, US Army (Ret.) · ex-DIA / DEA",
  sponsors: [
    { name: "Satellite Phone Store", url: "https://sat123.com", offer: "Save 10%, code PRATHER" },
  ],
  patreonUrl: "https://www.patreon.com/JeffreyPrather",
  signOff: "Jeff · Isaiah 6:8",
};

describe("it has to survive real email clients", () => {
  /**
   * Outlook on Windows renders through Microsoft Word: no flexbox, no grid, no
   * max-width on a div. A div-based layout collapses to full bleed and the
   * email becomes unreadable at desktop width.
   */
  it("lays out with tables, not divs", () => {
    const html = renderBriefingEmail(email);
    expect(html).toMatch(/<table[^>]*role="presentation"/);
    expect(html).not.toMatch(/display:\s*flex/i);
    expect(html).not.toMatch(/display:\s*grid/i);
  });

  it("carries a viewport tag", () => {
    const html = renderBriefingEmail(email);
    expect(html).toContain('name="viewport"');
  });

  it("is light, and says so, so no client re-themes it", () => {
    const html = renderBriefingEmail(email);
    expect(html).toMatch(/name="color-scheme" content="light"/);
    expect(html).toMatch(/name="supported-color-schemes" content="light"/);
    // The card and the page behind it are both declared. An email that sets a
    // background but inherits its text colour is the one that turns
    // white-on-white the day a client decides to theme it.
    expect(html).toMatch(/<body style="[^"]*background:#ececed/);
    expect(html).toMatch(/<body style="[^"]*color:#16161a/);
    expect(html).toMatch(/background:#ffffff/);
  });

  it("is fluid, with no fixed-width table to force a sideways scroll", () => {
    const html = renderBriefingEmail(email);
    expect(html).toMatch(/max-width:600px/);
    // A width="600" attribute cannot shrink. The only one allowed is inside
    // the MSO conditional, which no phone ever parses.
    const outsideMso = html.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, "");
    expect(outsideMso).not.toMatch(/width="600"/);
    expect(html).toMatch(/<!--\[if mso\]>[\s\S]*?width="600"/);
  });

  it("defaults to the mobile layout, so stripping the CSS cannot break it", () => {
    const html = renderBriefingEmail(email);
    // Gmail serving a non-Gmail account drops the <style> block wholesale.
    // Under a max-width architecture that renders DESKTOP on a phone. The
    // inline defaults must therefore be the small ones, and the media query
    // must widen rather than narrow.
    expect(html).toMatch(/<h1 class="h1" style="[^"]*font-size:26px/);
    expect(html).toMatch(/@media screen and \(min-width:621px\)/);
    expect(html).not.toMatch(/@media[^{]*max-width/);
    const stripped = html.replace(/<style[\s\S]*?<\/style>/g, "");
    expect(stripped).toMatch(/padding:12px 20px 20px/);
    expect(stripped).not.toMatch(/padding-left:34px/);
  });

  it("gives the button a full-width tap target without needing the media query", () => {
    const html = renderBriefingEmail(email);
    expect(html).toMatch(/<table role="presentation" class="cta"[^>]*style="width:100%/);
    expect(html).toMatch(/<a href="[^"]*" style="display:block/);
  });

  it("builds the button as a bgcolor table cell", () => {
    const html = renderBriefingEmail(email);
    expect(html).toMatch(/<td bgcolor="#c8102e"/);
    expect(html).toContain(email.watchUrl);
  });

  it("inlines the styles that matter rather than relying on the stylesheet", () => {
    const html = renderBriefingEmail(email);
    // Gmail strips <head> on some clients; type and colour must survive that.
    expect(html).toMatch(/<h1 class="h1" style="[^"]*font-size:26px/);
  });
});

describe("content", () => {
  it("renders every bullet", () => {
    const html = renderBriefingEmail(email);
    for (const bullet of email.bullets) expect(html).toContain(bullet);
  });

  it("splits the brief into paragraphs", () => {
    const html = renderBriefingEmail(email);
    expect(html).toContain("Jeff here. I was there in 2003.");
    expect(html).toContain("Here&#039;s the tell: the timing.".replace("&#039;", "'"));
    expect((html.match(/<p class="body-text" style="margin:0 0 18px/g) ?? []).length).toBe(2);
  });

  it("escapes HTML in operator-supplied copy", () => {
    const html = renderBriefingEmail({ ...email, headline: 'A <script>alert("x")</script> B' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the button, Patreon and sponsors when they are absent", () => {
    const html = renderBriefingEmail({
      ...email,
      watchUrl: null,
      patreonUrl: null,
      sponsors: [],
    });
    expect(html).not.toMatch(/Watch today/);
    expect(html).not.toMatch(/Patreon/);
    expect(html).not.toMatch(/sponsors/i);
  });

  /** Mailchimp requires these or the campaign cannot be sent. */
  it("includes the unsubscribe merge tags", () => {
    const html = renderBriefingEmail(email);
    expect(html).toContain("*|UNSUB|*");
    expect(html).toContain("*|LIST:ADDRESSLINE|*");
  });

  it("writes a plain-text alternative carrying the same substance", () => {
    const text = renderBriefingText(email);
    expect(text).toContain(email.headline);
    for (const bullet of email.bullets) expect(text).toContain(bullet);
    expect(text).toContain(email.watchUrl);
    expect(text).not.toMatch(/<[a-z]/i);
  });
});
