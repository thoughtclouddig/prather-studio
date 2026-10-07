import { describe, expect, it } from "vitest";
import { merchSlug, merchUrl } from "@/lib/integrations/printful/client";

const ITEM = { slug: "freedom-is-taken-tee", printfulId: "384729", externalId: "99887" };

describe("slugs", () => {
  it("makes a URL-safe slug from a product name", () => {
    expect(merchSlug("Freedom Is Taken Tee")).toBe("freedom-is-taken-tee");
    expect(merchSlug("Prather Point — Coffee & Mug")).toBe("prather-point-coffee-and-mug");
    expect(merchSlug("  Trailing / Slashes  ")).toBe("trailing-slashes");
  });

  it("strips accents rather than percent-encoding them into the slug", () => {
    expect(merchSlug("Café Patriot")).toBe("cafe-patriot");
  });
});

describe("building the shop link", () => {
  it("fills the template", () => {
    expect(merchUrl("https://jeffreyprather.com/shop/{slug}", ITEM)).toBe(
      "https://jeffreyprather.com/shop/freedom-is-taken-tee",
    );
  });

  it("supports the Printful id and the storefront id", () => {
    expect(merchUrl("https://x.test/p/{id}", ITEM)).toBe("https://x.test/p/384729");
    expect(merchUrl("https://x.test/p/{external_id}", ITEM)).toBe("https://x.test/p/99887");
  });

  it("adds a scheme rather than producing a relative link in an email", () => {
    expect(merchUrl("jeffreyprather.com/shop/{slug}", ITEM)).toBe(
      "https://jeffreyprather.com/shop/freedom-is-taken-tee",
    );
  });

  it("returns nothing when no template is configured", () => {
    // The briefing then omits merch entirely rather than linking nowhere.
    expect(merchUrl(null, ITEM)).toBeNull();
    expect(merchUrl("   ", ITEM)).toBeNull();
  });

  it("refuses a template whose token this item cannot fill", () => {
    // {external_id} on a store that reports none would otherwise put a literal
    // "{external_id}" into an email that has already been sent.
    const noExternal = { ...ITEM, externalId: null };
    expect(merchUrl("https://x.test/p/{external_id}", noExternal)).toBeNull();
    expect(merchUrl("https://x.test/p/{sku}", ITEM)).toBeNull();
  });

  it("refuses a template that is not a URL", () => {
    expect(merchUrl("not a url {slug}", ITEM)).toBeNull();
  });
});
