import Link from "next/link";
import { db } from "@/db/client";
import { shows } from "@/db/schema";
import { requirePermission } from "@/lib/auth/require";
import { CREATED_PLATFORMS, DEFAULT_INTENTS } from "@/lib/domain/create-episode";
import { cadenceFrom, getNextExpectedShowSlot } from "@/lib/domain/schedule";
import { PLATFORM_LABEL } from "@/lib/domain/vocabulary";
import { toShowInputValue } from "@/lib/format";
import { Panel } from "@/components/ui";
import { NewEpisodeForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewEpisodePage({
  searchParams,
}: {
  searchParams: Promise<{ at?: string }>;
}) {
  const [{ at }] = await Promise.all([searchParams, requirePermission("episode.create")]);
  const [show] = await db.select().from(shows).limit(1);

  // Prefer the slot the Dashboard offered; otherwise derive the next expected
  // one from the same domain function the Dashboard uses, so the two can never
  // disagree. That calculation used to be duplicated here with a hardcoded
  // -04:00 offset, which silently broke outside daylight time.
  const slot = show ? getNextExpectedShowSlot(new Date(), cadenceFrom(show)) : null;
  const defaultScheduledAt =
    at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)
      ? at
      : slot
        ? toShowInputValue(slot.startsAt)
        : "";

  return (
    <div className="space-y-5 max-w-[820px]">
      <div>
        <div className="eyebrow">
          <Link href="/studio/episodes" className="hover:text-[var(--color-type-hi)]">
            Episodes
          </Link>
          {" / New"}
        </div>
        <h1 className="display text-[26px] mt-1">Create an episode</h1>
      </div>

      <NewEpisodeForm
        defaultScheduledAt={defaultScheduledAt}
        showName={show?.name ?? "The Prather Point"}
        cadence={show?.cadenceNote ?? null}
        platformCount={CREATED_PLATFORMS.length}
      />

      <Panel eyebrow="Created automatically" title="Platform rows and their starting intent">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Intent</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {CREATED_PLATFORMS.map((platform) => (
              <tr key={platform}>
                <td className="font-semibold">{PLATFORM_LABEL[platform]}</td>
                <td>
                  <span className="tag">{DEFAULT_INTENTS[platform]}</span>
                </td>
                <td className="text-[12px] text-[var(--color-type-lo)]">
                  {platform === "OPUSCLIP"
                    ? "Held — clips are not a Phase 2 workflow yet."
                    : platform === "LOCALS"
                      ? "Held — Locals has no write API, so publishing is a manual handoff."
                      : platform === "RUMBLE"
                        ? "Scheduled, then observed. The Studio never publishes to Rumble."
                        : platform === "YOUTUBE"
                          ? "The one platform the Studio can fully read and write."
                          : "Adapter arrives in a later phase."}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
