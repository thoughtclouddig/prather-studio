/** Recurring-description probe (development only). Read-only. */
import "dotenv/config";
import { authorize } from "@/lib/integrations/youtube/client";

const IDS = [
  "dc3omqxnHss","c3ysgJ3NQM4","X5hhFCiMWeQ","Ha6fZ8pxUx8","bLrHzWjcCyg",
  "cW4_hfR8FKY","DTqvJwxDw5k","EyxnyeV-cHE","CKng12po7Ik","PbijwSCv9Ec",
  "TqbQZJcvW9A","a8epG1kePss","7qD26FN_vc4","gEC4Jc6lq5k","oGt2ttznPAg",
  "xrgVp0T532A","ZUtAGc7dTxY","3JymFl-mUuY","yGdhAJH1pBs","qWUGEKd5Jk4",
  "NNR4wUsprmo","rd2pACCHjn4","Fd4w0vd8p08",
];

async function main() {
  const { accessToken } = await authorize();
  const out: unknown[] = [];
  for (let i = 0; i < IDS.length; i += 20) {
    const chunk = IDS.slice(i, i + 20);
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,liveStreamingDetails&id=${chunk.join(",")}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const body = await res.json();
    if (!res.ok) { console.error(JSON.stringify(body).slice(0, 300)); process.exit(1); }
    out.push(...body.items);
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
main();
