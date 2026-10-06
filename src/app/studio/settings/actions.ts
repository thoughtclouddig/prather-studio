"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { shows, sponsors } from "@/db/schema";
import { requirePermission } from "@/lib/auth/require";
import { recordActivity } from "@/lib/domain/activity";

export type ActionState = { ok?: string; error?: string } | undefined;

/**
 * Sponsor management.
 *
 * Sponsors are STANDING content: the same six blocks, with the same promo
 * codes, on every briefing. They were seeded once and then only editable by
 * hand in the database, which meant a code changing — the thing most likely to
 * change — needed a developer.
 *
 * Gated on `settings.edit`, which is OWNER-only. A sponsor block carries a
 * promo code that someone is being paid for; it is publishing defaults, not
 * episode content.
 */
async function guarded(fn: () => Promise<string>): Promise<ActionState> {
  try {
    const ok = await fn();
    revalidatePath("/studio/settings", "page");
    return { ok };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function clean(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? "").trim();
  return value || null;
}

/** A sponsor URL ends up in an email. A malformed one is a dead link in it. */
function checkUrl(url: string | null): string | null {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname.includes(".")) throw new Error("no dot");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`"${url}" is not a web address. Leave it blank or use a full link.`);
  }
}

export async function createSponsorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("settings.edit");

    const name = clean(form, "name");
    if (!name) throw new Error("A sponsor needs a name.");

    const [show] = await db.select().from(shows).limit(1);
    if (!show) throw new Error("No show is configured yet.");

    // Append. New sponsors go last rather than jumping the order someone
    // deliberately arranged.
    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${sponsors.sortOrder}), -1) + 1` })
      .from(sponsors)
      .where(eq(sponsors.showId, show.id));

    await db.insert(sponsors).values({
      showId: show.id,
      name,
      url: checkUrl(clean(form, "url")),
      offer: clean(form, "offer"),
      sortOrder: next,
    });

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "sponsor.created",
      subjectType: "settings",
      subjectId: show.id,
      summary: `Added the sponsor "${name}"`,
      after: { name },
    });

    return `Added ${name}.`;
  });
}

export async function updateSponsorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("settings.edit");

    const id = String(form.get("id") ?? "");
    const name = clean(form, "name");
    if (!name) throw new Error("A sponsor needs a name.");

    const [existing] = await db.select().from(sponsors).where(eq(sponsors.id, id)).limit(1);
    if (!existing) throw new Error("That sponsor no longer exists.");

    await db
      .update(sponsors)
      .set({
        name,
        url: checkUrl(clean(form, "url")),
        offer: clean(form, "offer"),
        active: form.get("active") === "on",
        updatedAt: new Date(),
      })
      .where(eq(sponsors.id, id));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "sponsor.updated",
      subjectType: "settings",
      subjectId: id,
      summary: `Updated the sponsor "${name}"`,
      before: { name: existing.name, offer: existing.offer, active: existing.active },
      after: { name, offer: clean(form, "offer"), active: form.get("active") === "on" },
    });

    return `Saved ${name}.`;
  });
}

/**
 * Remove a sponsor.
 *
 * A real delete rather than a flag, because `active` already exists for
 * "paused, keep the row". Reaching for delete means the relationship ended,
 * and the activity log keeps the record of it having existed.
 */
export async function deleteSponsorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("settings.edit");
    const id = String(form.get("id") ?? "");

    const [existing] = await db.select().from(sponsors).where(eq(sponsors.id, id)).limit(1);
    if (!existing) throw new Error("That sponsor no longer exists.");

    await db.delete(sponsors).where(eq(sponsors.id, id));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "sponsor.deleted",
      subjectType: "settings",
      subjectId: id,
      summary: `Removed the sponsor "${existing.name}"`,
      before: { name: existing.name, offer: existing.offer, url: existing.url },
    });

    return `Removed ${existing.name}.`;
  });
}

/** Move one place up or down. The email renders them in this order. */
export async function reorderSponsorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    await requirePermission("settings.edit");
    const id = String(form.get("id") ?? "");
    const direction = String(form.get("direction") ?? "");

    const [row] = await db.select().from(sponsors).where(eq(sponsors.id, id)).limit(1);
    if (!row) throw new Error("That sponsor no longer exists.");

    const siblings = await db
      .select()
      .from(sponsors)
      .where(eq(sponsors.showId, row.showId))
      .orderBy(sponsors.sortOrder);

    const index = siblings.findIndex((s) => s.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= siblings.length) return "Already at the end.";

    const other = siblings[target]!;
    // Swap the two positions rather than renumbering the list: fewer writes,
    // and a gap in the sequence never matters because only the order is read.
    await db.update(sponsors).set({ sortOrder: other.sortOrder }).where(eq(sponsors.id, row.id));
    await db.update(sponsors).set({ sortOrder: row.sortOrder }).where(eq(sponsors.id, other.id));

    return `Moved ${row.name} ${direction}.`;
  });
}


/**
 * Import the sponsors an operator ticked from a previous campaign.
 *
 * Only the ticked ones, and only ones not already present by name — running
 * this twice should not produce two of everything, and an operator correcting
 * a code by hand should not have it overwritten by a re-import of the email it
 * came from.
 */
export async function importSponsorsAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("settings.edit");

    const picked = form.getAll("sponsor").map(String);
    if (picked.length === 0) throw new Error("Tick the sponsors you want to keep.");

    const [show] = await db.select().from(shows).limit(1);
    if (!show) throw new Error("No show is configured yet.");

    const existing = await db.select().from(sponsors).where(eq(sponsors.showId, show.id));
    const taken = new Set(existing.map((s) => s.name.toLowerCase().trim()));

    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${sponsors.sortOrder}), -1) + 1` })
      .from(sponsors)
      .where(eq(sponsors.showId, show.id));

    const rows: Array<{ name: string; url: string | null; offer: string | null }> = [];
    for (const raw of picked) {
      let parsed: { name?: string; url?: string | null; offer?: string | null };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        continue;
      }
      const name = parsed.name?.trim();
      if (!name || taken.has(name.toLowerCase())) continue;
      taken.add(name.toLowerCase());
      rows.push({
        name,
        url: parsed.url?.trim() || null,
        offer: parsed.offer?.trim() || null,
      });
    }

    if (rows.length === 0) {
      return "Those sponsors are already in the list — nothing to add.";
    }

    await db.insert(sponsors).values(
      rows.map((row, i) => ({
        showId: show.id,
        name: row.name,
        url: row.url,
        offer: row.offer,
        sortOrder: next + i,
      })),
    );

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "sponsor.imported",
      subjectType: "settings",
      subjectId: show.id,
      summary: `Imported ${rows.length} sponsor${rows.length === 1 ? "" : "s"} from a previous campaign`,
      after: { names: rows.map((r) => r.name) },
    });

    const skipped = picked.length - rows.length;
    return (
      `Added ${rows.length} sponsor${rows.length === 1 ? "" : "s"}.` +
      (skipped > 0 ? ` ${skipped} already existed and ${skipped === 1 ? "was" : "were"} left alone.` : "")
    );
  });
}
