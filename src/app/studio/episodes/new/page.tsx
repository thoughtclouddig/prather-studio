import Link from "next/link";
import { db } from "@/db/client";
import { shows } from "@/db/schema";
import { requirePermission } from "@/lib/auth/require";
import { CREATED_PLATFORMS, DEFAULT_INTENTS } from "@/lib/domain/create-episode";
import { PLATFORM_LABEL } from "@/lib/domain/vocabulary";
import { toShowInputValue } from "@/lib/format";
import { Panel } from "@/components/ui";
import { NewEpisodeForm } from "./form";

export const dynamic = "force-dynamic";

/** Next Tuesday or Thursday at the show's usual start time. */
function nextShowSlot(startTime: string): Date {
  const [hour, minute] = startTime.split(":").map(Number);
  const now = new Date();
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    const day = candidate.getDay();
    if (day !== 2 && day !== 4) continue;
    // The input is in ET; nudge by the show's hour in that zone.
    const et = new Date(
      `${candidate.toISOString().slice(0, 10)}T${String(hour ?? 14).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}:00-04:00`,
    );
    if (et.getTime() > now.getTime()) return et;
  }
  return now;
}

export default async function NewEpisodePage() {
  await requirePermission("episode.create");
  const [show] = await db.select().from(shows).limit(1);

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
        defaultScheduledAt={toShowInputValue(nextShowSlot(show?.defaultStartTime ?? "14:00"))}
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
