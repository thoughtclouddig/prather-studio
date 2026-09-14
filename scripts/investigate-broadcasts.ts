/**
 * Live-broadcast binding probe (development only). Read-only.
 *
 * The videos probe showed two simultaneous livestreams per show. This asks
 * whether they were bound to the SAME ingest stream (one encoder, YouTube
 * transcoding twice) or to DIFFERENT ingest streams (the encoder pushing two
 * separate RTMP destinations). That distinction decides where the duplicate
 * is created, so it is worth one extra request.
 */
import "dotenv/config";

import { authorize } from "@/lib/integrations/youtube/client";

const IDS = ["cqbI52zgl7o", "NNR4wUsprmo", "rd2pACCHjn4", "Fd4w0vd8p08"];

async function get(path: string) {
  const { accessToken } = await authorize();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

async function main() {
  const b = await get(
    `liveBroadcasts?part=id,snippet,contentDetails,status&id=${IDS.join(",")}`,
  );
  console.log("### liveBroadcasts.list ###", b.status);
  console.log(JSON.stringify(b.body, null, 2));

  const s = await get("liveStreams?part=id,snippet,cdn,status&mine=true&maxResults=25");
  console.log("\n### liveStreams.list (mine) ###", s.status);
  console.log(JSON.stringify(s.body, null, 2));
  process.exit(0);
}

main();
