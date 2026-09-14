import { describe, expect, it } from "vitest";
import {
  preStreamStatus,
  RUMBLE_PLACEHOLDER_MAX_SECONDS,
} from "@/lib/domain/pre-stream";
import type { PreStreamAsset, PreStreamState } from "@/db/schema";

const asset = (over: Partial<PreStreamAsset> = {}): PreStreamAsset =>
  ({
    id: "asset-1",
    showId: "show-1",
    label: "Team America intro",
    description: null,
    sourceUrl: "https://drive.example/intro.mp4",
    durationSeconds: 45,
    active: true,
    notes: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as PreStreamAsset;

const episode = (state: PreStreamState, assetId: string | null = "asset-1") => ({
  preStreamState: state,
  preStreamAssetId: assetId,
});

describe("pre-stream video status", () => {
  it("blocks readiness when nothing has been chosen", () => {
    const status = preStreamStatus(episode("NOT_SELECTED", null), null);
    expect(status.label).toBe("NOT SELECTED");
    expect(status.blocksReadiness).toBe(true);
    expect(status.assetLabel).toBeNull();
  });

  /** The exact label the operator asked for. */
  it("says SELECTED — MANUAL SETUP REQUIRED once chosen but not set up", () => {
    const status = preStreamStatus(episode("SELECTED"), asset());
    expect(status.label).toBe("SELECTED — MANUAL SETUP REQUIRED");
    expect(status.assetLabel).toBe("Team America intro");
    expect(status.blocksReadiness).toBe(true);
  });

  /**
   * Rumble has no API for this. The instruction has to name the actual place
   * and the actual control, or it is not an instruction.
   */
  it("tells the operator where to do it, and says the Studio cannot", () => {
    const status = preStreamStatus(episode("SELECTED"), asset());
    expect(status.instruction).toContain("rumble.com/live");
    expect(status.instruction).toContain("SELECT A PLACEHOLDER VIDEO");
    expect(status.instruction).toMatch(/no API|cannot do it for you/i);
  });

  it("stops blocking once confirmed in Rumble", () => {
    const status = preStreamStatus(episode("CONFIRMED_IN_RUMBLE"), asset());
    expect(status.label).toBe("SET UP IN RUMBLE");
    expect(status.blocksReadiness).toBe(false);
    expect(status.instruction).toBeNull();
  });

  it("a selection with no asset row falls back to NOT SELECTED", () => {
    const status = preStreamStatus(episode("SELECTED", null), null);
    expect(status.state).toBe("NOT_SELECTED");
    expect(status.blocksReadiness).toBe(true);
  });

  it("can be marked not applicable without blocking", () => {
    const status = preStreamStatus(episode("NOT_APPLICABLE", null), null);
    expect(status.blocksReadiness).toBe(false);
    expect(status.instruction).toBeNull();
  });
});

describe("Rumble's 60-second placeholder limit", () => {
  it("warns about a clip Rumble will reject", () => {
    const status = preStreamStatus(episode("SELECTED"), asset({ durationSeconds: 90 }));
    expect(status.warning).toContain("90s");
    expect(status.warning).toContain(`${RUMBLE_PLACEHOLDER_MAX_SECONDS}s`);
  });

  it("does not warn at exactly the limit", () => {
    const status = preStreamStatus(
      episode("SELECTED"),
      asset({ durationSeconds: RUMBLE_PLACEHOLDER_MAX_SECONDS }),
    );
    expect(status.warning).toBeNull();
  });

  it("does not warn when the duration is unknown", () => {
    const status = preStreamStatus(episode("SELECTED"), asset({ durationSeconds: null }));
    expect(status.warning).toBeNull();
  });

  /** A warning informs; it does not override the operator's choice. */
  it("warns without blocking differently", () => {
    const status = preStreamStatus(episode("SELECTED"), asset({ durationSeconds: 90 }));
    expect(status.label).toBe("SELECTED — MANUAL SETUP REQUIRED");
  });
});
