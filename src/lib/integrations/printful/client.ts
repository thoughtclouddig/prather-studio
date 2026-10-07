/**
 * Printful — the merch store behind the briefing's product block.
 *
 * ## What Printful is, and why that shapes this
 *
 * Printful is FULFILMENT, not a storefront. It prints and ships; the shop a
 * customer actually buys from may be Shopify, Etsy, Woo, or one of Printful's
 * own hosted stores. That distinction decides the whole feature, because an
 * email needs a link a reader can click, and a product's public URL is a
 * property of the STOREFRONT, not of Printful.
 *
 * So this reads what Printful genuinely knows — the products, their images,
 * their retail prices — and nothing else. The public link comes from the
 * storefront side: `merchUrl()` fills a template configured in Settings,
 * because the shop is part of OUR website and its URL scheme is a decision we
 * make, not a third party's pattern to reverse-engineer.
 *
 * ## Auth
 *
 * Bearer token. A store-level token is scoped to one store; an account-level
 * token can see several and needs `X-PF-Store-Id` to say which. Both are
 * handled, because an operator creating a token in the Printful dashboard is
 * not told which kind they made.
 *
 * ## The envelope
 *
 * Every v1 response is wrapped: `{ code, result }`. A failing `code` inside a
 * 200 response is a real Printful behaviour, so the HTTP status alone is not
 * trusted.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

const API = "https://api.printful.com";

export interface PrintfulCredentialPayload {
  token: string;
  /** Set only when the token is account-level and sees more than one store. */
  storeId?: string | null;
  /** The storefront address, captured at connect time. Printful may not know it. */
  website?: string | null;
  storeType?: string | null;
}

export class PrintfulApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PrintfulApiError";
  }
}

export class PrintfulNotConnectedError extends Error {
  constructor() {
    super("Printful is not connected. Add the API token in Integrations.");
    this.name = "PrintfulNotConnectedError";
  }
}

async function credential(): Promise<PrintfulCredentialPayload> {
  const stored = await readCredential<PrintfulCredentialPayload>("PRINTFUL");
  if (!stored) throw new PrintfulNotConnectedError();
  return stored.payload;
}

async function call<T>(path: string, c: PrintfulCredentialPayload): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${c.token}`,
      "content-type": "application/json",
      ...(c.storeId ? { "x-pf-store-id": c.storeId } : {}),
    },
    cache: "no-store",
  });

  const text = await res.text();
  let body: { code?: number; result?: unknown; error?: { message?: string } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    /* fall through to the status-based message */
  }

  const message = body.error?.message ?? text.slice(0, 300);

  if (!res.ok) {
    throw new PrintfulApiError(
      res.status,
      res.status === 401
        ? "Printful rejected that token."
        : res.status === 403
          ? "That token lacks permission for this. Check its scopes in Printful."
          : `Printful returned ${res.status}: ${message}`,
    );
  }

  if (typeof body.code === "number" && body.code >= 400) {
    throw new PrintfulApiError(body.code, `Printful returned ${body.code}: ${message}`);
  }

  return body.result as T;
}

export interface PrintfulStore {
  id: number;
  name: string;
  /** The storefront's own address, when Printful knows it. Often absent. */
  website: string | null;
  /** "shopify", "etsy", "manual", "printful" and so on. */
  type: string | null;
}

function toStore(raw: Record<string, unknown>): PrintfulStore {
  return {
    id: Number(raw["id"] ?? 0),
    name: String(raw["name"] ?? "Printful store"),
    website: typeof raw["website"] === "string" && raw["website"] ? raw["website"] : null,
    type: typeof raw["type"] === "string" ? raw["type"] : null,
  };
}

/**
 * Stores this token can see.
 *
 * A store-level token is refused by `/stores` but answers `/store`, so the
 * narrow call is tried first. The other order reports "forbidden" for a token
 * that is working perfectly.
 */
export async function listStores(
  token: string,
  storeId?: string | null,
): Promise<PrintfulStore[]> {
  const c: PrintfulCredentialPayload = { token, storeId: storeId ?? null };

  try {
    const one = await call<Record<string, unknown>>("/store", c);
    if (one && typeof one["id"] === "number") return [toStore(one)];
  } catch (error) {
    if (error instanceof PrintfulApiError && error.status === 401) throw error;
  }

  const many = await call<Array<Record<string, unknown>>>("/stores", c);
  return (many ?? []).map(toStore);
}

export interface PrintfulProduct {
  id: number;
  /** The STOREFRONT's id for this product, not Printful's. */
  externalId: string | null;
  name: string;
  thumbnailUrl: string | null;
  variantCount: number;
  syncedCount: number;
}

/** Products configured in the connected store. */
export async function listProducts(limit = 20): Promise<PrintfulProduct[]> {
  const c = await credential();
  const rows = await call<Array<Record<string, unknown>>>(`/store/products?limit=${limit}`, c);

  return (rows ?? []).map((raw) => ({
    id: Number(raw["id"] ?? 0),
    externalId:
      typeof raw["external_id"] === "string" && raw["external_id"] ? raw["external_id"] : null,
    name: String(raw["name"] ?? ""),
    thumbnailUrl: typeof raw["thumbnail_url"] === "string" ? raw["thumbnail_url"] : null,
    variantCount: Number(raw["variants"] ?? 0),
    syncedCount: Number(raw["synced"] ?? 0),
  }));
}

export interface PrintfulProductDetail extends PrintfulProduct {
  /** Lowest retail price across variants, as the store set it. */
  fromPrice: string | null;
  currency: string | null;
}

export async function getProduct(id: number): Promise<PrintfulProductDetail> {
  const c = await credential();
  const data = await call<{
    sync_product?: Record<string, unknown>;
    sync_variants?: Array<Record<string, unknown>>;
  }>(`/store/products/${id}`, c);

  const product = data.sync_product ?? {};
  const variants = data.sync_variants ?? [];

  const prices = variants
    .map((v) => Number(v["retail_price"]))
    .filter((n) => Number.isFinite(n) && n > 0);

  const first = variants[0];

  return {
    id: Number(product["id"] ?? id),
    externalId: typeof product["external_id"] === "string" ? product["external_id"] : null,
    name: String(product["name"] ?? ""),
    thumbnailUrl:
      typeof product["thumbnail_url"] === "string" ? product["thumbnail_url"] : null,
    variantCount: Number(product["variants"] ?? variants.length),
    syncedCount: Number(product["synced"] ?? variants.length),
    fromPrice: prices.length > 0 ? Math.min(...prices).toFixed(2) : null,
    currency: typeof first?.["currency"] === "string" ? String(first["currency"]) : null,
  };
}

/**
 * Slugify a product name for a shop URL.
 *
 * Stored rather than computed at render time: a product renamed in Printful
 * would otherwise silently change the URL of a page that is already linked
 * from emails that have gone out.
 */
export function merchSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Build a merch item's public URL from the configured template.
 *
 * The storefront is part of OUR website — Printful fulfils the order, but the
 * shop page is ours — so the URL scheme is a decision rather than a pattern to
 * reverse-engineer from a third party. Earlier this tried to infer a link from
 * the store platform, which was the right caution for somebody else's
 * storefront and is simply the wrong model for our own.
 *
 * No template means no link, and the briefing omits the merch block entirely.
 * A merch item linking nowhere is worse than one that is not there.
 */
export function merchUrl(
  template: string | null | undefined,
  item: { slug: string; printfulId: string; externalId?: string | null },
): string | null {
  const pattern = template?.trim();
  if (!pattern) return null;

  const values: Record<string, string> = {
    slug: item.slug,
    id: item.printfulId,
    external_id: item.externalId ?? "",
  };

  let missing = false;
  const filled = pattern.replace(/\{([a-z_]+)\}/gi, (_whole, token: string) => {
    const value = values[token.toLowerCase()];
    // An empty value is as broken as an unknown token — {external_id} on a
    // store that reports none would collapse to a URL pointing at the shop
    // root, which looks like a working link and is not the product.
    if (!value) {
      missing = true;
      return "";
    }
    return encodeURIComponent(value);
  });

  if (missing) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(filled) ? filled : `https://${filled}`);
    return url.toString();
  } catch {
    return null;
  }
}
