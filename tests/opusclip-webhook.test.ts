import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_AGE_SECONDS,
  parseWebhook,
  verifyWebhook,
} from "@/lib/integrations/opusclip/webhook";

const SECRET = "sk-test-secret";
const NOW = new Date("2026-10-13T12:00:00Z");

function signed(body: string, salt = "a1b2c3d4", at: Date = NOW) {
  return {
    body,
    salt,
    timestamp: String(Math.floor(at.getTime() / 1000)),
    signature: createHmac("sha256", SECRET).update(body + salt).digest("hex"),
    secret: SECRET,
    now: NOW,
  };
}

describe("the signature is the only thing guarding a public endpoint", () => {
  it("accepts a genuine callback", () => {
    expect(verifyWebhook(signed('{"stage":"COMPLETE"}'))).toMatchObject({ ok: true });
  });

  it("refuses a body that changed in transit", () => {
    const req = signed('{"stage":"COMPLETE"}');
    const result = verifyWebhook({ ...req, body: '{"stage":"STALLED"}' });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses the wrong secret", () => {
    const result = verifyWebhook({ ...signed("{}"), secret: "sk-someone-elses" });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses when a header is missing", () => {
    const req = signed("{}");
    for (const missing of ["signature", "salt", "timestamp"] as const) {
      expect(verifyWebhook({ ...req, [missing]: null })).toMatchObject({ ok: false });
    }
  });

  it("refuses when no secret is configured, rather than accepting everything", () => {
    expect(verifyWebhook({ ...signed("{}"), secret: "" })).toMatchObject({ ok: false });
  });
});

describe("a valid signature is not enough on its own", () => {
  it("refuses a stale request, however well signed", () => {
    // A captured request would otherwise be replayable for ever.
    const old = new Date(NOW.getTime() - (MAX_AGE_SECONDS + 60) * 1000);
    const result = verifyWebhook(signed("{}", "a1b2c3d4", old));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/older than/);
  });

  it("accepts one just inside the window", () => {
    const recent = new Date(NOW.getTime() - (MAX_AGE_SECONDS - 10) * 1000);
    expect(verifyWebhook(signed("{}", "a1b2c3d4", recent))).toMatchObject({ ok: true });
  });

  it("refuses a salt that has been seen before", () => {
    const result = verifyWebhook({ ...signed("{}"), seenSalt: () => true });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/replay/);
  });

  it("checks the replay store only after the signature passes", () => {
    // Otherwise anyone who knows the URL could fill it with junk salts.
    let asked = false;
    verifyWebhook({
      ...signed("{}"),
      signature: "deadbeef",
      seenSalt: () => {
        asked = true;
        return false;
      },
    });
    expect(asked).toBe(false);
  });

  it("refuses a timestamp that is not a number", () => {
    expect(verifyWebhook({ ...signed("{}"), timestamp: "soon" })).toMatchObject({
      ok: false,
    });
  });
});

describe("reading the payload", () => {
  it("finds the project whether it is wrapped or at the top level", () => {
    expect(parseWebhook({ projectId: "p1", stage: "COMPLETE" }).projectId).toBe("p1");
    expect(parseWebhook({ project: { projectId: "p2", stage: "COMPLETE" } }).projectId).toBe("p2");
    expect(parseWebhook({ data: { id: "p3", stage: "RENDER" } }).projectId).toBe("p3");
  });

  it("treats STALLED and an error as failure", () => {
    expect(parseWebhook({ projectId: "p", stage: "STALLED" }).failed).toBe(true);
    expect(parseWebhook({ projectId: "p", stage: "RENDER", error: "no credits" }).failed).toBe(
      true,
    );
    expect(parseWebhook({ projectId: "p", stage: "COMPLETE" }).failed).toBe(false);
  });

  it("reports nothing it cannot find rather than inventing it", () => {
    // Their webhook payload is not documented, so an unexpected shape has to
    // degrade to "I do not know" instead of a confident wrong answer.
    expect(parseWebhook({})).toEqual({ projectId: null, stage: null, failed: false });
    expect(parseWebhook(null)).toEqual({ projectId: null, stage: null, failed: false });
  });
});
