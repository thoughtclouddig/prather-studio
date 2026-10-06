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
 * their retail prices — and treats the public link as something to be
 * established rather than assumed. `productUrl()` refuses to invent a link it
 * cannot derive: a merch block pointing at a 404 is worse than no merch block.
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
 * The public URL for a product, or null when one cannot be derived.
 *
 * Deliberately conservative. Printful returns no storefront link, and the
 * mapping from its `external_id` to a public URL differs per platform —
 * Shopify uses a numeric product id, Etsy a listing id, a manual store may
 * have no public page at all. A guessed link 404s for every reader, which is
 * worse than sending them to the shop's front page and saying so.
 */
export function productUrl(
  product: { externalId: string | null },
  store: { website: string | null; type: string | null },
): { url: string | null; exact: boolean } {
  const base = store.website?.replace(/\/+$/, "") ?? null;
  if (!base) return { url: null, exact: false };

  if (store.type === "shopify" && product.externalId) {
    return { url: `${base}/products/${product.externalId}`, exact: true };
  }

  return { url: base, exact: false };
}
