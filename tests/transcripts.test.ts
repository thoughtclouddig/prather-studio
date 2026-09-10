import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dedupeRollingCues,
  detectFormat,
  formatTimestamp,
  parseTimestamp,
  parseTranscript,
} from "@/lib/transcripts/parse";
import { chooseTrack } from "@/lib/domain/transcripts";
import type { YouTubeCaptionTrack } from "@/lib/integrations/youtube/client";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("timestamps", () => {
  it("parses both VTT and SRT decimal forms", () => {
    expect(parseTimestamp("00:00:03.719")).toBeCloseTo(3.719);
    expect(parseTimestamp("00:01:02,250")).toBeCloseTo(62.25);
    expect(parseTimestamp("01:02:03.000")).toBe(3723);
  });

  it("formats the way YouTube chapters require", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(62)).toBe("1:02");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });
});

describe("caption parsing", () => {
  it("detects each format", () => {
    expect(detectFormat(fixture("youtube-asr.vtt"))).toBe("vtt");
    expect(detectFormat(fixture("manual.srt"))).toBe("srt");
    expect(detectFormat(fixture("track.ttml"))).toBe("ttml");
  });

  /**
   * The load-bearing case. YouTube's ASR output repeats the previous cue's tail
   * at the head of the next; parsed naively the words arrive two or three
   * times and every downstream word count is wrong.
   */
  it("collapses YouTube's rolling ASR cues to the words spoken once", () => {
    const parsed = parseTranscript(fixture("youtube-asr.vtt"));
    const text = parsed.plainText.toLowerCase();

    expect(text).toContain("five american installations were struck");
    expect(text).toContain("the briefing rooms went quiet");

    // Each phrase exactly once, not once per rolling cue.
    expect(text.match(/five american installations/g)).toHaveLength(1);
    expect(text.match(/briefing rooms/g)).toHaveLength(1);
  });

  it("strips per-word timing tags and markup", () => {
    const parsed = parseTranscript(fixture("youtube-asr.vtt"));
    expect(parsed.plainText).not.toContain("<c>");
    expect(parsed.plainText).not.toContain("00:00:00.719");
    expect(parsed.plainText).not.toContain("<");
  });

  it("preserves timecodes exactly", () => {
    const parsed = parseTranscript(fixture("manual.srt"), { merge: false });
    expect(parsed.segments[0]!.startTime).toBe(0);
    expect(parsed.segments[2]!.startTime).toBeCloseTo(62.25);
    expect(parsed.segments[2]!.endTime).toBe(68);
  });

  it("extracts a speaker prefix", () => {
    const parsed = parseTranscript(fixture("manual.srt"), { merge: false });
    expect(parsed.segments[0]!.speaker).toBe("Jeffrey Prather");
    expect(parsed.segments[0]!.text).toBe("Five U.S. bases were hit.");
  });

  it("parses TTML with spans, entities and dur=", () => {
    const parsed = parseTranscript(fixture("track.ttml"), { merge: false });
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[1]!.endTime).toBe(9);
    expect(parsed.segments[2]!.text).toBe("Here's what CENTCOM actually conceded.");
  });

  it("merges tiny cues but keeps the outer timecodes", () => {
    const parsed = parseTranscript(fixture("manual.srt"));
    const first = parsed.segments[0]!;
    // Cues 1 and 2 sit within the 20s merge window; cue 3 is a minute later.
    expect(parsed.segments).toHaveLength(2);
    expect(first.startTime).toBe(0);
    expect(first.endTime).toBe(9);
    expect(first.text).toContain("Five U.S. bases were hit.");
    expect(first.text).toContain("The Pentagon called it something else.");
    expect(parsed.durationSeconds).toBe(68);
  });

  /**
   * A speaker label persists until another one appears. Without this a
   * single-host show never merges past its first labelled cue.
   */
  it("carries a speaker label forward across unlabelled cues", () => {
    const parsed = parseTranscript(fixture("manual.srt"), { merge: false });
    expect(parsed.segments.map((s) => s.speaker)).toEqual([
      "Jeffrey Prather",
      "Jeffrey Prather",
      "Jeffrey Prather",
    ]);
  });

  it("handles an exact duplicate cue without duplicating text", () => {
    const deduped = dedupeRollingCues([
      { startTime: 0, endTime: 2, text: "hello there" },
      { startTime: 2, endTime: 4, text: "hello there" },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.endTime).toBe(4);
  });
});

describe("caption track selection", () => {
  const track = (over: Partial<YouTubeCaptionTrack>): YouTubeCaptionTrack => ({
    id: "t", language: "en", name: "", trackKind: "asr", status: "serving",
    isDraft: false, isAutoSynced: true, lastUpdated: "2026-09-08T00:00:00Z", ...over,
  });

  it("prefers a human track over auto-generated", () => {
    const chosen = chooseTrack([
      track({ id: "asr", trackKind: "asr" }),
      track({ id: "human", trackKind: "standard" }),
    ]);
    expect(chosen?.id).toBe("human");
  });

  it("falls back to ASR, which is the normal case", () => {
    expect(chooseTrack([track({ id: "asr" })])?.id).toBe("asr");
  });

  it("prefers English when several languages exist", () => {
    const chosen = chooseTrack([
      track({ id: "es", language: "es" }),
      track({ id: "en", language: "en-US" }),
    ]);
    expect(chosen?.id).toBe("en");
  });

  it("ignores drafts", () => {
    expect(chooseTrack([track({ id: "draft", isDraft: true })])).toBeNull();
  });
});
