/** YouTube Analytics capability probe (development only). Read-only. */
import "dotenv/config";
import { authorize } from "@/lib/integrations/youtube/client";

async function q(path: string, token: string) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const { accessToken, scopes } = await authorize();
  console.log("GRANTED SCOPES:", scopes.join(" "));

  const A = "https://youtubeanalytics.googleapis.com/v2/reports";

  // 1. Can we get a retroactive daily time series? This decides whether
  //    channel-growth history is recoverable or must be snapshotted from now.
  const daily = await q(
    `${A}?ids=channel==MINE&startDate=2026-06-01&endDate=2026-09-13` +
      `&metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost` +
      `&dimensions=day`,
    accessToken,
  );
  console.log("\n### daily channel time series ###", daily.status);
  if (daily.ok) {
    const rows = daily.body.rows ?? [];
    console.log("columns:", (daily.body.columnHeaders ?? []).map((c: {name:string}) => c.name).join(", "));
    console.log("rows:", rows.length, "first:", JSON.stringify(rows[0]), "last:", JSON.stringify(rows[rows.length - 1]));
  } else {
    console.log(JSON.stringify(daily.body).slice(0, 400));
  }

  // 2. Per-video engagement: the metrics that actually say whether an episode
  //    held people, not just whether it was clicked.
  const perVideo = await q(
    `${A}?ids=channel==MINE&startDate=2026-06-01&endDate=2026-09-13` +
      `&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained` +
      `&dimensions=video&sort=-views&maxResults=10`,
    accessToken,
  );
  console.log("\n### per-video engagement ###", perVideo.status);
  if (perVideo.ok) {
    console.log("columns:", (perVideo.body.columnHeaders ?? []).map((c: {name:string}) => c.name).join(", "));
    for (const r of (perVideo.body.rows ?? []).slice(0, 6)) console.log(" ", JSON.stringify(r));
  } else {
    console.log(JSON.stringify(perVideo.body).slice(0, 400));
  }

  // 3. Traffic source — does the thumbnail/title work? Impressions + CTR live
  //    in a separate dimension set and are the whole point of thumbnail work.
  const ctr = await q(
    `${A}?ids=channel==MINE&startDate=2026-06-01&endDate=2026-09-13` +
      `&metrics=views&dimensions=insightTrafficSourceType&sort=-views`,
    accessToken,
  );
  console.log("\n### traffic sources ###", ctr.status);
  console.log(ctr.ok ? JSON.stringify(ctr.body.rows) : JSON.stringify(ctr.body).slice(0, 300));

  // 4. Impressions & CTR are Creator-Studio-only on many accounts. Ask.
  const impressions = await q(
    `${A}?ids=channel==MINE&startDate=2026-06-01&endDate=2026-09-13` +
      `&metrics=impressions,impressionClickThroughRate`,
    accessToken,
  );
  console.log("\n### impressions / CTR ###", impressions.status);
  console.log(JSON.stringify(impressions.body).slice(0, 400));
  process.exit(0);
}
main();
