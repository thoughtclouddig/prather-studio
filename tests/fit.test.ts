import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { describe as inspect, fitMaster, fitSquare, MASTER, SQUARE } from "@/lib/images/fit";

/** A stand-in for a generated frame, at the size the model actually renders. */
const frame = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 24, b: 20 } },
  })
    .png()
    .toBuffer();

describe("fitting to the size platforms demand", () => {
  /**
   * gpt-image-1 cannot render 16:9 at all — 1024x1024, 1536x1024, 1024x1536.
   * YouTube wants 1920x1080, so the conversion has to be exact and checked.
   */
  it("turns a 3:2 generation into exactly 1920x1080", async () => {
    const out = await fitMaster(await frame(1536, 1024));
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1080);

    const actual = await inspect(out.bytes);
    expect(actual.width).toBe(1920);
    expect(actual.height).toBe(1080);
    expect(actual.format).toBe("jpeg");
  });

  it("produces exactly 1024x1024 for the square", async () => {
    const out = await fitSquare(await frame(1024, 1024));
    const actual = await inspect(out.bytes);
    expect(actual.width).toBe(1024);
    expect(actual.height).toBe(1024);
  });

  /** A frame generated at an unexpected size must not ship at that size. */
  it("corrects a frame generated at the wrong size", async () => {
    const out = await fitMaster(await frame(1024, 1024));
    const actual = await inspect(out.bytes);
    expect(actual.width).toBe(1920);
    expect(actual.height).toBe(1080);
  });

  /** YouTube rejects anything over 2 MB. */
  it("stays well under YouTube's 2 MB limit", async () => {
    const out = await fitMaster(await frame(1536, 1024));
    expect(out.bytes.length).toBeLessThan(MASTER.maxBytes);
    expect(out.quality).toBeGreaterThanOrEqual(74);
  });

  it("keeps the square under its own budget", async () => {
    const out = await fitSquare(await frame(1024, 1024));
    expect(out.bytes.length).toBeLessThan(SQUARE.maxBytes);
  });

  it("always reports image/jpeg", async () => {
    const out = await fitMaster(await frame(1536, 1024));
    expect(out.contentType).toBe("image/jpeg");
  });
});
