/** Buzzsprout matcher dry-run against the live account. Read-only. */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, episodes } from "@/db/schema";
import { listEpisodes as listBz } from "@/lib/integrations/buzzsprout/client";
import { getVideo } from "@/lib/integrations/youtube/client";
import { matchBuzzsproutEpisode } from "@/lib/domain/buzzsprout-match";

async function main() {
  const all = await db.select().from(episodes);
  const canonical = all.find((e) => e.airedAt);
  if (!canonical) { console.log("no aired episode"); process.exit(0); }

  const [pub] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, canonical.id),
        eq(episodePublications.platform, "YOUTUBE"),
      ),
    );
  const videoId = pub?.externalId ?? null;
  const video = videoId ? await getVideo(videoId) : null;

  console.log("CANONICAL EPISODE");
  console.log("  title   :", canonical.approvedTitle ?? canonical.workingTitle);
  console.log("  airedAt :", canonical.airedAt?.toISOString());
  console.log("  video   :", videoId, video?.durationSeconds, "s");

  const bz = await listBz(40);
  console.log(`\nFetched ${bz.length} Buzzsprout episodes.\n`);

  const result = matchBuzzsproutEpisode(
    {
      airedAt: canonical.airedAt,
      videoDurationSeconds: video?.durationSeconds ?? null,
      title: canonical.approvedTitle ?? canonical.workingTitle,
    },
    bz.map((e) => ({
      id: e.id,
      title: e.title,
      publishedAt: e.publishedAt,
      durationSeconds: e.durationSeconds,
    })),
  );

  console.log("BEST:", result.best ? `#${result.best.episode.id} "${result.best.episode.title}"` : "(none)");
  console.log("AMBIGUOUS:", result.ambiguous ?? "no");
  console.log("REQUIRES CONFIRMATION:", result.requiresConfirmation);
  console.log("\nTOP CANDIDATES");
  console.log("-".repeat(100));
  for (const c of result.candidates.slice(0, 5)) {
    console.log(
      `${(c.confidence).toFixed(3)}  Δdur=${String(c.durationDeltaSeconds).padStart(6)}s  ` +
      `lag=${String(c.publishLagDays).padStart(4)}d  title=${(c.titleScore * 100).toFixed(0)}%  ` +
      `${c.disqualified ? "DQ" : "ok"}  ${c.episode.title.slice(0, 44)}`,
    );
    for (const r of c.reasons) console.log(`        · ${r}`);
  }
  process.exit(0);
}
main();
