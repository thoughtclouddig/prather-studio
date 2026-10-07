import { describe, expect, it } from "vitest";
import { extractSponsors } from "@/lib/domain/sponsor-import";

const HTML = `
<table><tr><td>
  <p>Today's sponsors</p>
  <p><a href="https://fieldsupply.example/?utm_source=mc">Field Supply Co.</a> &mdash; use code PRATHER for 15% off</p>
  <p><a href="https://readyreserve.example">Ready Reserve Foods</a> &mdash; promo code POINT at checkout</p>
  <p><a href="https://www.patreon.com/JeffreyPrather">Join on Patreon</a></p>
  <p><a href="https://rumble.com/c/PratherPoint">Watch on Rumble</a></p>
  <p><a href="https://facebook.com/x">Follow us</a></p>
  <p><a href="*|UNSUB|*">Unsubscribe</a></p>
</td></tr></table>`;

const TEXT = `Today's sponsors
Field Supply Co. - use code PRATHER for 15% off
Ready Reserve Foods - promo code POINT at checkout
Cliffside Coffee — code WAKEUP https://cliffside.example
Unsubscribe: https://list-manage.com/unsub`;

describe("finding sponsors in a sent briefing", () => {
  it("finds the sponsors and their codes", () => {
    const found = extractSponsors(HTML, TEXT);
    const names = found.map((f) => f.name);
    expect(names).toContain("Field Supply Co.");
    expect(names).toContain("Ready Reserve Foods");

    const field = found.find((f) => f.name === "Field Supply Co.")!;
    expect(field.offer).toMatch(/code PRATHER/i);
    expect(field.url).toBe("https://fieldsupply.example/");
    expect(field.confident).toBe(true);
  });

  it("never offers Patreon, Rumble, socials or the unsubscribe link", () => {
    const names = extractSponsors(HTML, TEXT).map((f) => f.name.toLowerCase());
    for (const excluded of ["join on patreon", "watch on rumble", "follow us", "unsubscribe"]) {
      expect(names).not.toContain(excluded);
    }
  });

  it("merges the two halves rather than listing a sponsor twice", () => {
    // The HTML carries the URL, the plain text carries the offer wording.
    const found = extractSponsors(HTML, TEXT);
    expect(found.filter((f) => f.name === "Field Supply Co.")).toHaveLength(1);
  });

  it("finds a sponsor the HTML pass missed, from the plain text alone", () => {
    const found = extractSponsors(HTML, TEXT);
    const coffee = found.find((f) => f.name.includes("Cliffside"))!;
    expect(coffee).toBeDefined();
    expect(coffee.offer).toMatch(/code WAKEUP/i);
    expect(coffee.url).toBe("https://cliffside.example");
  });

  it("puts the ones carrying a promo code first and pre-ticks only those", () => {
    const found = extractSponsors(HTML, TEXT);
    const firstUnsure = found.findIndex((f) => !f.confident);
    if (firstUnsure !== -1) {
      expect(found.slice(firstUnsure).every((f) => !f.confident)).toBe(true);
    }
    expect(found.some((f) => f.confident)).toBe(true);
  });

  it("strips tracking parameters from the link", () => {
    const field = extractSponsors(HTML, TEXT).find((f) => f.name === "Field Supply Co.")!;
    expect(field.url).not.toContain("utm_source");
  });

  it("returns nothing rather than guessing from an empty campaign", () => {
    expect(extractSponsors("", "")).toEqual([]);
  });
});
