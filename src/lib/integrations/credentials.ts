/**
 * Credential storage.
 *
 * This is the ONLY module that decrypts a provider credential. Everything else
 * asks it for a usable token, or asks for the safe public view. There is no
 * function here that returns ciphertext and plaintext together, and nothing
 * that returns a secret is reachable from a client component.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  integrationCredentials,
  type CredentialKind,
  type IntegrationCredential,
  type IntegrationHealth,
  type IntegrationProvider,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { decryptJson, encryptJson } from "@/lib/crypto/secretbox";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "@/lib/domain/activity";

/** What we store for a YouTube OAuth connection. */
export interface YouTubeCredentialPayload {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/** What we store for the Rumble Live Stream API. The URL *is* the secret. */
export interface RumbleCredentialPayload {
  apiUrl: string;
}

export interface SaveCredentialInput {
  provider: IntegrationProvider;
  kind: CredentialKind;
  payload: unknown;
  scopes?: string[];
  expiresAt?: Date | null;
  accountLabel?: string | null;
  accountExternalId?: string | null;
  actor?: Actor;
  connectedBy?: string | null;
}

export async function saveCredential(
  input: SaveCredentialInput,
): Promise<IntegrationCredential> {
  const values = {
    provider: input.provider,
    kind: input.kind,
    encryptedPayload: encryptJson(input.payload),
    scopes: input.scopes ?? null,
    expiresAt: input.expiresAt ?? null,
    accountLabel: input.accountLabel ?? null,
    accountExternalId: input.accountExternalId ?? null,
    health: "CONNECTED" as IntegrationHealth,
    lastSuccessAt: new Date(),
    lastError: null,
    connectedBy: input.connectedBy ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(integrationCredentials)
    .values(values)
    .onConflictDoUpdate({ target: integrationCredentials.provider, set: values })
    .returning();

  await recordActivity({
    actor: input.actor ?? SYSTEM_ACTOR,
    verb: "integration.connected",
    subjectType: "integration",
    subjectId: input.provider,
    summary: `${input.provider} connected${input.accountLabel ? ` — ${input.accountLabel}` : ""}`,
    after: { provider: input.provider, scopes: input.scopes ?? [] },
  });

  return row!;
}

/** The decrypted payload. Server-only, and never returned to a page. */
export async function readCredential<T>(
  provider: IntegrationProvider,
): Promise<{ record: IntegrationCredential; payload: T } | null> {
  const [record] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, provider))
    .limit(1);
  if (!record) return null;
  return { record, payload: decryptJson<T>(record.encryptedPayload) };
}

/**
 * The only shape a page or component may receive. `encryptedPayload` is not a
 * field on this type, so it cannot be leaked by forgetting to strip it.
 */
export interface PublicIntegration {
  provider: IntegrationProvider;
  kind: CredentialKind;
  health: IntegrationHealth;
  scopes: string[];
  expiresAt: Date | null;
  accountLabel: string | null;
  accountExternalId: string | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastObservation: unknown;
  lastObservedAt: Date | null;
  connectedAt: Date;
}

function toPublic(row: IntegrationCredential): PublicIntegration {
  return {
    provider: row.provider,
    kind: row.kind,
    health: row.health,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt,
    accountLabel: row.accountLabel,
    accountExternalId: row.accountExternalId,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    lastObservation: row.lastObservation,
    lastObservedAt: row.lastObservedAt,
    connectedAt: row.createdAt,
  };
}

export async function listIntegrations(): Promise<PublicIntegration[]> {
  const rows = await db.select().from(integrationCredentials);
  return rows.map(toPublic);
}

export async function getIntegration(
  provider: IntegrationProvider,
): Promise<PublicIntegration | null> {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, provider))
    .limit(1);
  return row ? toPublic(row) : null;
}

export async function markHealth(
  provider: IntegrationProvider,
  health: IntegrationHealth,
  error?: string | null,
): Promise<void> {
  await db
    .update(integrationCredentials)
    .set({
      health,
      lastError: error ?? null,
      lastSuccessAt: health === "CONNECTED" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(integrationCredentials.provider, provider));
}

export async function recordObservation(
  provider: IntegrationProvider,
  observation: unknown,
): Promise<void> {
  await db
    .update(integrationCredentials)
    .set({
      lastObservation: observation as never,
      lastObservedAt: new Date(),
      health: "CONNECTED",
      lastError: null,
      lastSuccessAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(integrationCredentials.provider, provider));
}

export async function disconnect(
  user: User,
  provider: IntegrationProvider,
): Promise<void> {
  authorize(user.role, "integration.configure");
  await db
    .delete(integrationCredentials)
    .where(eq(integrationCredentials.provider, provider));

  await recordActivity({
    actor: { kind: "user", id: user.id, name: user.name },
    verb: "integration.disconnected",
    subjectType: "integration",
    subjectId: provider,
    summary: `${provider} disconnected — stored credential deleted`,
  });
}
