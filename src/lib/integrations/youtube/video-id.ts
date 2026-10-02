/**
 * Accepts whatever an operator is likely to paste: a bare ID, a watch URL, a
 * youtu.be short link, a /live/ URL (what a finished stream's address looks
 * like), an embed URL, or a Shorts URL.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) return match[1]!;
  }
  return null;
}
