/**
 * Authenticated encryption for stored provider credentials.
 *
 * AES-256-GCM from node:crypto. GCM is chosen over CBC because it authenticates
 * as well as encrypts: a tampered ciphertext fails to decrypt rather than
 * decrypting to garbage that downstream code might act on.
 *
 * Format: v1.<iv>.<authTag>.<ciphertext>, each part base64url.
 * The version prefix exists so the key or algorithm can be rotated later
 * without guessing at what an old row contains.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — the GCM standard nonce size
const KEY_LENGTH = 32; // 256 bits

export class CredentialDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

/**
 * Resolve the encryption key. Accepts base64, base64url or hex, and demands
 * exactly 32 bytes — a short key would silently weaken every stored credential.
 */
export function resolveKey(raw?: string): Buffer {
  const value = (raw ?? process.env.CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
  if (!value) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes, got ${key.length}.`,
    );
  }
  return key;
}

export function encryptJson(value: unknown, key?: Buffer): string {
  const k = key ?? resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptJson<T = unknown>(payload: string, key?: Buffer): T {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialDecryptionError("Stored credential is not in the expected format.");
  }
  const [, ivPart, tagPart, dataPart] = parts;

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key ?? resolveKey(),
      Buffer.from(ivPart!, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart!, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart!, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    // A wrong key, a truncated payload and a tampered payload all land here.
    // They are deliberately indistinguishable to the caller.
    throw new CredentialDecryptionError(
      "Could not decrypt the stored credential. The encryption key may have changed.",
    );
  }
}

/** Never log a token. Use this when an identifier must appear in a message. */
export function redact(secret: string | null | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}
