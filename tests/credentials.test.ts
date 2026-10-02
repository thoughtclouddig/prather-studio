import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { integrationCredentials } from "@/db/schema";
import {
  CredentialDecryptionError,
  decryptJson,
  encryptJson,
  redact,
  resolveKey,
} from "@/lib/crypto/secretbox";
import { resetDb } from "./helpers";

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

beforeEach(resetDb);

describe("credential encryption", () => {
  it("round-trips a payload with the right key", () => {
    const secret = { accessToken: "ya29.super-secret", refreshToken: "1//refresh" };
    const restored = decryptJson<typeof secret>(encryptJson(secret, KEY_A), KEY_A);
    expect(restored).toEqual(secret);
  });

  /** The whole point: a database dump must not contain readable tokens. */
  it("never leaves the secret readable in the ciphertext", () => {
    const payload = encryptJson({ accessToken: "ya29.super-secret" }, KEY_A);
    expect(payload).not.toContain("ya29");
    expect(payload).not.toContain("super-secret");
    expect(payload).not.toContain("accessToken");
    expect(payload.startsWith("v1.")).toBe(true);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encryptJson({ token: "same" }, KEY_A);
    const b = encryptJson({ token: "same" }, KEY_A);
    expect(a).not.toBe(b);
    expect(decryptJson(a, KEY_A)).toEqual(decryptJson(b, KEY_A));
  });

  it("fails safely with the wrong key — no partial plaintext", () => {
    const payload = encryptJson({ accessToken: "ya29.super-secret" }, KEY_A);
    expect(() => decryptJson(payload, KEY_B)).toThrow(CredentialDecryptionError);
  });

  /** GCM authenticates. A flipped byte must fail, not decrypt to garbage. */
  it("rejects a tampered payload", () => {
    const payload = encryptJson({ accessToken: "ya29.secret" }, KEY_A);
    const parts = payload.split(".");
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64url");
    expect(() => decryptJson(parts.join("."), KEY_A)).toThrow(CredentialDecryptionError);
  });

  it("rejects a malformed or unversioned payload", () => {
    expect(() => decryptJson("not-a-payload", KEY_A)).toThrow(CredentialDecryptionError);
    expect(() => decryptJson("v2.a.b.c", KEY_A)).toThrow(CredentialDecryptionError);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => resolveKey(Buffer.from("too-short").toString("base64"))).toThrow(/32 bytes/);
    expect(() => resolveKey("")).toThrow(/not set/);
  });

  it("accepts hex and base64 keys alike", () => {
    const key = randomBytes(32);
    expect(resolveKey(key.toString("hex")).equals(key)).toBe(true);
    expect(resolveKey(key.toString("base64")).equals(key)).toBe(true);
  });

  it("redact() never returns the whole secret", () => {
    expect(redact("ya29.a-very-long-access-token")).not.toContain("very-long");
    expect(redact("short")).toBe("****");
    expect(redact(null)).toBe("(none)");
  });
});

describe("credential storage", () => {
  it("stores ciphertext in the database, not the token", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_A.toString("base64");
    const { saveCredential, readCredential, listIntegrations } = await import(
      "@/lib/integrations/credentials"
    );

    await saveCredential({
      provider: "YOUTUBE",
      kind: "OAUTH",
      payload: { accessToken: "ya29.leak-me", refreshToken: "1//leak", tokenType: "Bearer" },
      scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
      accountLabel: "JP Intel",
    });

    const [row] = await db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.provider, "YOUTUBE"));

    expect(row!.encryptedPayload).not.toContain("ya29");
    expect(row!.encryptedPayload).not.toContain("leak");

    const read = await readCredential<{ accessToken: string }>("YOUTUBE");
    expect(read?.payload.accessToken).toBe("ya29.leak-me");

    // The public view is the only shape a page receives, and it has no
    // ciphertext field at all — a token cannot leak by forgetting to strip it.
    const [publicView] = await listIntegrations();
    expect(publicView).toBeDefined();
    expect(JSON.stringify(publicView)).not.toContain("ya29");
    expect("encryptedPayload" in (publicView as object)).toBe(false);
    expect(publicView!.accountLabel).toBe("JP Intel");
  });

  it("re-connecting replaces the credential rather than adding a second", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_A.toString("base64");
    const { saveCredential } = await import("@/lib/integrations/credentials");

    await saveCredential({ provider: "RUMBLE", kind: "URL_SECRET", payload: { apiUrl: "https://a" } });
    await saveCredential({ provider: "RUMBLE", kind: "URL_SECRET", payload: { apiUrl: "https://b" } });

    const rows = await db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.provider, "RUMBLE"));
    expect(rows).toHaveLength(1);
  });
});
