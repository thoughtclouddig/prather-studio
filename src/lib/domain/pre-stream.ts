/**
 * Pre-stream (placeholder) video selection.
 *
 * ## What this actually is, from the provider's own documentation
 *
 * Rumble's livestream setup at rumble.com/live has a step "SELECT A PLACEHOLDER
 * VIDEO — upload a video with a duration of up to 60 seconds", which "will act
 * as a placeholder that will loop before the stream starts". Rumble creates the
 * video entity as soon as the stream is set up, and that entity plays the
 * placeholder to the audience until the encoder feed arrives.
 *
 * ## Who is responsible for playback
 *
 * **Rumble, not StreamYard.** StreamYard is an RTMP source — it pushes a feed
 * at the stream key Rumble issues. It has nothing to send before the broadcast
 * begins, and it has no public API at all. The placeholder is played by Rumble
 * from a file uploaded during Rumble's own setup flow.
 *
 * ## Can it be automated
 *
 * **No.** Rumble's only documented API is the Live Stream API at
 * rumble.com/account/livestream-api, which is read-only: followers,
 * subscribers, and whatever is live right now. There is no documented endpoint
 * to create a livestream, schedule one, or set its placeholder video. The
 * placeholder is chosen by uploading a file in the browser.
 *
 * So the Studio does not pretend. It tracks WHICH video is wanted, tells the
 * operator plainly that Rumble Studio is where it becomes real, and refuses to
 * call a show fully prepared until someone confirms it was done.
 */
import type { PreStreamAsset, PreStreamState } from "@/db/schema";

/** Rumble's documented cap on the placeholder clip. */
export const RUMBLE_PLACEHOLDER_MAX_SECONDS = 60;

export interface PreStreamStatus {
  state: PreStreamState;
  /** Short label for the dashboard, e.g. "SELECTED — MANUAL SETUP REQUIRED". */
  label: string;
  /** The chosen clip's name, or null when nothing is chosen. */
  assetLabel: string | null;
  /** What the operator has to do next, in plain words. Null when nothing. */
  instruction: string | null;
  /** True when this blocks the show from reading as prepared. */
  blocksReadiness: boolean;
  /** Set when the chosen clip breaks a Rumble constraint. */
  warning: string | null;
}

export function preStreamStatus(
  episode: {
    preStreamState: PreStreamState;
    preStreamAssetId: string | null;
  },
  asset: PreStreamAsset | null,
): PreStreamStatus {
  const assetLabel = asset?.label ?? null;

  const warning =
    asset?.durationSeconds && asset.durationSeconds > RUMBLE_PLACEHOLDER_MAX_SECONDS
      ? `"${asset.label}" is ${asset.durationSeconds}s. Rumble accepts a placeholder of ` +
        `up to ${RUMBLE_PLACEHOLDER_MAX_SECONDS}s, so this will be rejected at upload.`
      : null;

  if (episode.preStreamState === "NOT_APPLICABLE") {
    return {
      state: "NOT_APPLICABLE",
      label: "NOT APPLICABLE",
      assetLabel,
      instruction: null,
      blocksReadiness: false,
      warning: null,
    };
  }

  if (episode.preStreamState === "CONFIRMED_IN_RUMBLE" && asset) {
    return {
      state: "CONFIRMED_IN_RUMBLE",
      label: "SET UP IN RUMBLE",
      assetLabel,
      instruction: null,
      blocksReadiness: false,
      warning,
    };
  }

  if (episode.preStreamState === "SELECTED" && asset) {
    return {
      state: "SELECTED",
      label: "SELECTED — MANUAL SETUP REQUIRED",
      assetLabel,
      instruction:
        `Upload "${asset.label}" as the placeholder video when creating the ` +
        "livestream at rumble.com/live — the step labelled SELECT A PLACEHOLDER " +
        "VIDEO. Rumble has no API for this, so the Studio cannot do it for you. " +
        "Mark it confirmed here once it is done.",
      blocksReadiness: true,
      warning,
    };
  }

  return {
    state: "NOT_SELECTED",
    label: "NOT SELECTED",
    assetLabel: null,
    instruction:
      "Choose which pre-stream video should play before this show. Rumble loops " +
      "it to the audience until the broadcast feed arrives.",
    blocksReadiness: true,
    warning: null,
  };
}

/**
 * Does the pre-stream choice prevent this show reading as prepared?
 *
 * Deliberately blocking. A show where nobody decided what the audience stares
 * at for the first minutes is not a prepared show, and a dashboard that says
 * otherwise is lying in the most visible possible way.
 */
export function blocksShowPrep(status: PreStreamStatus): boolean {
  return status.blocksReadiness;
}
