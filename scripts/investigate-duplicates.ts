/**
 * Duplicate-video provenance probe (development only).
 *
 * Phase 2 found two public copies of the same broadcast on the JP INTEL
 * channel. This asks YouTube for every part it will give an owner and dumps
 * the raw answer, so the conclusion rests on provider data rather than a
 * plausible story. It is read-only: nothing here writes to YouTube.
 *
 * Run: npx tsx --tsconfig worker/tsconfig.json scripts/investigate-duplicates.ts
 */
import "dotenv/config";

import { authorize } from "@/lib/integrations/youtube/client";

const PAIRS = [
  { day: "Sep 8", ids: ["cqbI52zgl7o", "NNR4wUsprmo"] },
  { day: "Sep 11", ids: ["rd2pACCHjn4", "Fd4w0vd8p08"] },
];

// fileDetails and processingDetails are owner-only, and are the parts most
// likely to distinguish "this was streamed" from "this file was uploaded".
const PARTS = [
  "snippet", "contentDetails", "status", "statistics",
  "liveStreamingDetails", "recordingDetails", "topicDetails",
  "fileDetails", "processingDetails",
].join(",");

async function main() {
  const { accessToken } = await authorize();
  const ids = PAIRS.flatMap((p) => p.ids);

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=${PARTS}&id=${ids.join(",")}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const body = await res.json();
  if (!res.ok) {
    console.error("REQUEST FAILED", res.status, JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const returned = new Set(body.items.map((v: { id: string }) => v.id));
  console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), pairs: PAIRS, items: body.items }, null, 2));
  console.error(`\nFetched ${body.items.length}/${ids.length} videos.`);
  for (const id of ids) if (!returned.has(id)) console.error(`  MISSING: ${id}`);
  process.exit(0);

}

main();
