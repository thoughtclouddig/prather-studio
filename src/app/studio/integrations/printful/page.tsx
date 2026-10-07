import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { Empty, Panel, StateBadge } from "@/components/ui";
import { readCredential } from "@/lib/integrations/credentials";
import {
  listProducts,
  merchSlug,
  merchUrl,
  PrintfulNotConnectedError,
  type PrintfulCredentialPayload,
} from "@/lib/integrations/printful/client";

export const dynamic = "force-dynamic";

/**
 * What Printful actually returns.
 *
 * Built before the merch block itself, deliberately. Printful's own docs do
 * not say whether a store product carries a public URL, and the honest way to
 * settle that is to look at the real account rather than to design around a
 * guess — the Rumble embed id, where the page slug and the player id turned
 * out to be different strings, is what guessing costs.
 */
export default async function PrintfulInspectorPage() {
  await requireUser();

  let products: Awaited<ReturnType<typeof listProducts>> | undefined;
  let error: string | null = null;
  let credential: PrintfulCredentialPayload | null = null;

  try {
    const stored = await readCredential<PrintfulCredentialPayload>("PRINTFUL");
    credential = stored?.payload ?? null;
    products = await listProducts(50);
  } catch (e) {
    error =
      e instanceof PrintfulNotConnectedError
        ? "Printful is not connected yet."
        : e instanceof Error
          ? e.message
          : String(e);
  }

  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);
  const template = config?.merchUrlTemplate ?? null;

  const store = {
    website: credential?.website ?? null,
    type: credential?.storeType ?? null,
  };

  const linkFor = (p: { id: number; externalId: string | null; name: string }) =>
    merchUrl(template, {
      slug: merchSlug(p.name),
      printfulId: String(p.id),
      externalId: p.externalId,
    });

  const linkable = (products ?? []).filter((p) => linkFor(p) !== null).length;

  return (
    <div className="stack">
      <Link href="/studio/integrations" className="link text-[12px]">
        &larr; Integrations
      </Link>

      <Panel
        eyebrow="Printful"
        title="What the API returns"
        actions={
          <span className="mono">
            {products ? `${products.length} products` : "—"}
          </span>
        }
      >
        {error ? (
          <Empty>{error}</Empty>
        ) : products && products.length === 0 ? (
          <Empty>
            The token works, but this store has no products configured yet.
          </Empty>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-[var(--color-ink-200)] grid gap-4 sm:grid-cols-3">
              <div>
                <div className="eyebrow mb-1">Link template</div>
                <div className="mono text-[12px] break-all">
                  {template ?? "not set"}
                </div>
              </div>
              <div>
                <div className="eyebrow mb-1">Store type</div>
                <div className="mono text-[12px]">{store.type ?? "unknown"}</div>
              </div>
              <div>
                <div className="eyebrow mb-1">Exactly linkable</div>
                <StateBadge
                  tone={linkable > 0 ? "done" : "waiting"}
                  label={`${linkable} of ${products?.length ?? 0}`}
                />
              </div>
            </div>

            {linkable === 0 && (
              <p className="px-4 py-2.5 text-[12px] text-[var(--color-signal-amber)] leading-relaxed border-b border-[var(--color-ink-200)]">
                No link template is set, so none of these can be linked and the briefing
                omits merch entirely. Set one in Settings once the shop&rsquo;s URLs are
                decided &mdash; for example{" "}
                <span className="mono">https://jeffreyprather.com/shop/&#123;slug&#125;</span>.
                The slug below is what <span className="mono">&#123;slug&#125;</span> becomes.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Printful id</th>
                    <th>Slug</th>
                    <th>Variants</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {(products ?? []).map((p) => {
                    const link = linkFor(p);
                    return (
                      <tr key={p.id}>
                        <td className="align-top">
                          <div className="flex items-center gap-2">
                            {p.thumbnailUrl && (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={p.thumbnailUrl}
                                alt=""
                                width={32}
                                height={32}
                                className="w-8 h-8 object-cover border border-[var(--color-ink-200)]"
                              />
                            )}
                            <span className="text-[12px]">{p.name}</span>
                          </div>
                        </td>
                        <td className="mono align-top">{p.id}</td>
                        <td className="mono align-top text-[11px]">{merchSlug(p.name)}</td>
                        <td className="mono align-top">
                          {p.syncedCount}/{p.variantCount}
                        </td>
                        <td className="align-top">
                          {link ? (
                            <a
                              href={link}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="link mono text-[11px] break-all"
                            >
                              {link}
                            </a>
                          ) : (
                            <span className="text-[11px] text-[var(--color-type-lo)]">
                              no template
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
