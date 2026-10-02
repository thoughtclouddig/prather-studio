/** Ingest-stream history probe (development only). Read-only. */
import "dotenv/config";
import { authorize } from "@/lib/integrations/youtube/client";

async function main() {
  const { accessToken } = await authorize();
  const all: unknown[] = [];
  let pageToken = "";
  do {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/liveStreams?part=id,snippet,cdn,status&mine=true&maxResults=25${pageToken ? `&pageToken=${pageToken}` : ""}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const body = await res.json();
    if (!res.ok) {
      console.error(`page failed ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      break; // partial history still answers the question
    }
    all.push(...body.items);
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}
main();
