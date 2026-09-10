/**
 * Caption parsing and normalization.
 *
 * Every transcript source — YouTube ASR, uploaded SRT, a future Whisper run —
 * is normalized to the same timecoded segments, so chapters and clip candidates
 * index into one shape regardless of where the words came from. The raw payload
 * is stored alongside, so a better parser can always be re-run.
 *
 * The hard part is YouTube's auto-generated VTT specifically: it emits rolling
 * cues where each cue repeats the tail of the previous one, plus inline
 * per-word timing tags. Parsed naively it triples the word count.
 */

export interface ParsedSegment {
  startTime: number;
  endTime: number;
  text: string;
  speaker?: string;
}

export interface ParsedTranscript {
  format: "vtt" | "srt" | "ttml";
  segments: ParsedSegment[];
  plainText: string;
  durationSeconds: number;
}

/* ------------------------------------------------------------- timestamps */

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, or SRT's comma form → seconds. */
export function parseTimestamp(value: string): number {
  const clean = value.trim().replace(",", ".");
  const parts = clean.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0] ?? NaN;
}

/** Seconds → `H:MM:SS` (or `M:SS`), the form YouTube chapters require. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/* ------------------------------------------------------------- cue text */

function cleanCueText(raw: string): string {
  return raw
    // YouTube ASR per-word timing: <00:00:01.199><c> word</c>
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
    .replace(/<\/?c[^>]*>/g, "")
    // Any other markup (<v Speaker>, <i>, <b>, TTML spans)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** `<v Jeffrey Prather>text` or `Jeffrey Prather: text` → speaker + text. */
function extractSpeaker(raw: string): { speaker?: string; text: string } {
  const voice = /^<v\s+([^>]+)>/.exec(raw);
  if (voice) return { speaker: voice[1]!.trim(), text: raw.slice(voice[0].length) };

  const colon = /^([A-Z][A-Za-z.'\- ]{1,30}):\s+/.exec(raw);
  if (colon) return { speaker: colon[1]!.trim(), text: raw.slice(colon[0].length) };

  return { text: raw };
}

/* ---------------------------------------------------------------- parsers */

function parseVtt(input: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const body = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    const arrowIndex = lines.findIndex((l) => l.includes("-->"));
    if (arrowIndex === -1) continue; // WEBVTT header, NOTE, STYLE, cue id

    const timing = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[arrowIndex]!);
    if (!timing) continue;

    const startTime = parseTimestamp(timing[1]!);
    const endTime = parseTimestamp(timing[2]!);
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) continue;

    const rawText = lines.slice(arrowIndex + 1).join(" ");
    const { speaker, text: withoutSpeaker } = extractSpeaker(rawText);
    const text = cleanCueText(withoutSpeaker);
    if (!text) continue;

    segments.push({ startTime, endTime, text, ...(speaker ? { speaker } : {}) });
  }
  return segments;
}

function parseSrt(input: string): ParsedSegment[] {
  // SRT differs from VTT only in the index line and the comma decimal, both of
  // which the VTT parser already tolerates.
  return parseVtt(input);
}

function parseTtml(input: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const paragraphs = input.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g);

  for (const [, attrs, inner] of paragraphs) {
    const begin = /\bbegin="([^"]+)"/.exec(attrs ?? "")?.[1];
    const end = /\bend="([^"]+)"/.exec(attrs ?? "")?.[1];
    const dur = /\bdur="([^"]+)"/.exec(attrs ?? "")?.[1];
    if (!begin) continue;

    const toSeconds = (v: string) =>
      v.endsWith("s") ? Number(v.slice(0, -1)) : parseTimestamp(v);

    const startTime = toSeconds(begin);
    const endTime = end
      ? toSeconds(end)
      : dur
        ? startTime + toSeconds(dur)
        : startTime;
    if (Number.isNaN(startTime)) continue;

    const text = cleanCueText((inner ?? "").replace(/<br\s*\/?>/g, " "));
    if (!text) continue;
    segments.push({ startTime, endTime, text });
  }
  return segments;
}

/* ------------------------------------------------------- ASR de-duplication */

/**
 * Collapse YouTube's rolling ASR cues.
 *
 * Auto-generated VTT repeats the previous cue's tail at the head of the next,
 * so the same words arrive two or three times. Keeping only each cue's NEW
 * suffix restores the spoken text exactly once.
 */
export function dedupeRollingCues(segments: ParsedSegment[]): ParsedSegment[] {
  const out: ParsedSegment[] = [];

  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (!previous) {
      out.push({ ...segment });
      continue;
    }

    // Exact repeat of the previous cue — extend it rather than duplicating.
    if (previous.text === segment.text) {
      previous.endTime = Math.max(previous.endTime, segment.endTime);
      continue;
    }

    // Rolling overlap: this cue starts with the previous cue's text.
    if (segment.text.startsWith(previous.text)) {
      const suffix = segment.text.slice(previous.text.length).trim();
      previous.endTime = Math.max(previous.endTime, segment.endTime);
      if (suffix) {
        out.push({ ...segment, text: suffix, startTime: previous.endTime });
      }
      continue;
    }

    // Partial word-level overlap: drop the shared prefix words.
    const prevWords = previous.text.split(" ");
    const nextWords = segment.text.split(" ");
    let overlap = Math.min(prevWords.length, nextWords.length);
    while (overlap > 0) {
      const tail = prevWords.slice(prevWords.length - overlap).join(" ");
      const head = nextWords.slice(0, overlap).join(" ");
      if (tail === head) break;
      overlap--;
    }
    const remainder = nextWords.slice(overlap).join(" ").trim();
    if (!remainder) {
      previous.endTime = Math.max(previous.endTime, segment.endTime);
      continue;
    }
    out.push({ ...segment, text: remainder });
  }

  return out;
}

/**
 * Carry a speaker label forward until it changes.
 *
 * Caption convention is that a "Name:" prefix labels the speaker until another
 * label appears, not just that one cue. Without this, a single-host show gets
 * one labelled segment followed by hundreds of unattributed ones, and the merge
 * step below refuses to join across the apparent speaker change.
 */
export function forwardFillSpeakers(segments: ParsedSegment[]): ParsedSegment[] {
  let current: string | undefined;
  return segments.map((segment) => {
    if (segment.speaker) current = segment.speaker;
    return current ? { ...segment, speaker: current } : { ...segment };
  });
}

/**
 * Merge tiny cues into readable segments.
 *
 * ASR emits a cue every second or two. Chapters, clip candidates and the
 * content engine all read better from ~20-second paragraphs, and the timecodes
 * stay exact because the merged segment keeps the first start and last end.
 */
export function mergeIntoSegments(
  segments: ParsedSegment[],
  targetSeconds = 20,
): ParsedSegment[] {
  const merged: ParsedSegment[] = [];
  let current: ParsedSegment | null = null;

  for (const segment of segments) {
    if (
      current &&
      current.speaker === segment.speaker &&
      segment.endTime - current.startTime <= targetSeconds
    ) {
      current.text = `${current.text} ${segment.text}`.trim();
      current.endTime = segment.endTime;
      continue;
    }
    if (current) merged.push(current);
    current = { ...segment };
  }
  if (current) merged.push(current);
  return merged;
}

/* ------------------------------------------------------------------- entry */

export function detectFormat(input: string): "vtt" | "srt" | "ttml" {
  const head = input.trimStart().slice(0, 200);
  if (head.startsWith("WEBVTT")) return "vtt";
  if (head.startsWith("<") && /<tt\b|<tt:|xmlns/.test(head)) return "ttml";
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},/.test(input.trimStart())) return "srt";
  return "vtt";
}

export function parseTranscript(
  input: string,
  opts: { format?: "vtt" | "srt" | "ttml"; merge?: boolean } = {},
): ParsedTranscript {
  const format = opts.format ?? detectFormat(input);
  const raw =
    format === "ttml" ? parseTtml(input) : format === "srt" ? parseSrt(input) : parseVtt(input);

  const deduped = forwardFillSpeakers(dedupeRollingCues(raw));
  const segments = opts.merge === false ? deduped : mergeIntoSegments(deduped);

  return {
    format,
    segments,
    plainText: segments
      .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
      .join("\n"),
    durationSeconds: segments.length ? Math.ceil(segments[segments.length - 1]!.endTime) : 0,
  };
}
