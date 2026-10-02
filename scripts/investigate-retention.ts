/** Per-video traffic + retention probe (development only). Read-only. */
import "dotenv/config";
import { authorize } from "@/lib/integrations/youtube/client";

const PAIR = ["cqbI52zgl7o", "NNR4wUsprmo"]; // Sep 8 portrait vs landscape

async function q(url: string, token: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

async function main() {
  const { accessToken } = await authorize();
  const A = "https://youtubeanalytics.googleapis.com/v2/reports";
  const range = "startDate=2026-09-08&endDate=2026-09-14";

  for (const id of PAIR) {
    console.log(`\n${"=".repeat(64)}\n${id}\n${"=".repeat(64)}`);

    const core = await q(
      `${A}?ids=channel==MINE&${range}&filters=video==${id}` +
        `&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained`,
      accessToken,
    );
    console.log("core:", core.ok ? JSON.stringify(core.body.rows) : JSON.stringify(core.body).slice(0, 200));

    const src = await q(
      `${A}?ids=channel==MINE&${range}&filters=video==${id}` +
        `&metrics=views,averageViewDuration&dimensions=insightTrafficSourceType&sort=-views`,
      accessToken,
    );
    console.log("traffic:", src.ok ? JSON.stringify(src.body.rows) : JSON.stringify(src.body).slice(0, 200));

    const dev = await q(
      `${A}?ids=channel==MINE&${range}&filters=video==${id}` +
        `&metrics=views&dimensions=deviceType&sort=-views`,
      accessToken,
    );
    console.log("devices:", dev.ok ? JSON.stringify(dev.body.rows) : "n/a");
  }

  // Which impression/CTR metric names does this account actually accept?
  console.log(`\n${"=".repeat(64)}\nIMPRESSION METRIC AVAILABILITY\n${"=".repeat(64)}`);
  for (const m of [
    "annotationImpressions",
    "cardImpressions",
    "adImpressions",
    "views,estimatedRevenue",
    "audienceWatchRatio",
    "relativeRetentionPerformance",
  ]) {
    const r = await q(`${A}?ids=channel==MINE&${range}&metrics=${m}`, accessToken);
    console.log(`  ${m.padEnd(30)} ${r.ok ? "OK " + JSON.stringify(r.body.rows) : r.status + " " + (r.body.error?.message ?? "").slice(0, 70)}`);
  }
  process.exit(0);
}
main();
