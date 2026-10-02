/**
 * YouTube OAuth scopes — verified against the current API reference, not assumed.
 *
 *   youtube.force-ssl        Required. It is the ONLY scope that satisfies all
 *                            four methods we need:
 *                              videos.list       (read metadata)
 *                              videos.update     (write title/description)
 *                              captions.list     (find caption tracks)
 *                              captions.download (retrieve the transcript)
 *                            It also covers thumbnails.set.
 *
 *                            Phase 1 proposed youtube.upload + youtube.readonly
 *                            + yt-analytics.readonly. That set is INSUFFICIENT:
 *                            captions.download accepts only youtube.force-ssl or
 *                            youtubepartner. Confirmed at
 *                            developers.google.com/youtube/v3/docs/captions/download
 *
 *   yt-analytics.readonly    Read-only. Requested now because analytics is a
 *                            stated near-term need and re-consenting on a
 *                            production channel is friction we can avoid once.
 *
 * Deliberately NOT requested:
 *   youtube.upload    Phase 2 explicitly does not upload. force-ssl does not
 *                     grant videos.insert, so if upload is ever added it will
 *                     require a fresh consent — which is correct.
 *   youtubepartner    A content-partner/CMS scope. Far broader than we need.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;

export const SCOPE_RATIONALE: Record<string, string> = {
  "https://www.googleapis.com/auth/youtube.force-ssl":
    "Read and update video metadata, set thumbnails, list and download caption tracks. The only scope that permits captions.download.",
  "https://www.googleapis.com/auth/yt-analytics.readonly":
    "Read-only channel and video analytics. Requested now to avoid re-consenting later.",
};

/** Quota units per call, from the current API reference. */
export const QUOTA_COST = {
  "channels.list": 1,
  "playlistItems.list": 1,
  "videos.list": 1,
  "videos.update": 50,
  "captions.list": 50,
  "captions.download": 200,
  "thumbnails.set": 50,
} as const;
