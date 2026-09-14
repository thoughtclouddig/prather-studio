/**
 * The guard on destructive development commands.
 *
 * `db:seed` truncates integration credentials and sessions. That was harmless
 * while the only credentials were fixtures. It stopped being harmless the
 * moment a real Google refresh token, a real Rumble Live Stream API URL and a
 * real Buzzsprout key lived in that table: re-authorising every provider
 * because somebody ran a convenience script is not an acceptable failure mode,
 * and OAuth in testing mode means re-consenting through a browser.
 *
 * So destructive commands refuse to run against a database that says it is
 * production. The override is deliberately awkward — a full sentence, not a
 * flag — because anything shorter gets typed reflexively.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { settings } from "./schema";

/** Typing this exact value in `I_UNDERSTAND_THIS_DESTROYS_PRODUCTION_DATA`. */
export const OVERRIDE_PHRASE = "yes destroy production data";

export class DestructiveOperationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveOperationRefused";
  }
}

export interface GuardContext {
  /** What the database says it is. Null on a database nobody has claimed. */
  databaseEnvironment: string | null;
  /** What the process says it is. */
  processEnvironment: string;
  overrideSupplied: boolean;
}

export async function readGuardContext(): Promise<GuardContext> {
  let databaseEnvironment: string | null = null;
  try {
    const [row] = await db
      .select({ env: settings.appEnvironment })
      .from(settings)
      .where(eq(settings.id, "global"))
      .limit(1);
    databaseEnvironment = row?.env ?? null;
  } catch {
    // A database with no settings table yet cannot be production.
    databaseEnvironment = null;
  }

  return {
    databaseEnvironment,
    processEnvironment: process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development",
    overrideSupplied:
      process.env["I_UNDERSTAND_THIS_DESTROYS_PRODUCTION_DATA"] === OVERRIDE_PHRASE,
  };
}

/**
 * Decide whether a destructive operation may proceed.
 *
 * Pure, so the rules are testable without a database. Either environment
 * claiming production is enough to block: the dangerous case is a developer
 * whose shell has the production `DATABASE_URL` exported, and in that case
 * their own `NODE_ENV` still says development. The database's own answer is
 * the one that matters, and it is the one the process did not supply.
 */
export function evaluateGuard(
  ctx: GuardContext,
  operation: string,
): { allowed: true } | { allowed: false; reason: string } {
  const looksProduction =
    isProduction(ctx.databaseEnvironment) || isProduction(ctx.processEnvironment);

  if (!looksProduction) return { allowed: true };

  if (ctx.overrideSupplied) return { allowed: true };

  const which = isProduction(ctx.databaseEnvironment)
    ? `the database identifies itself as "${ctx.databaseEnvironment}"`
    : `this process declares APP_ENV="${ctx.processEnvironment}"`;

  return {
    allowed: false,
    reason:
      `Refusing to run ${operation}: ${which}.\n\n` +
      "This command truncates integration credentials. Real provider connections " +
      "(YouTube OAuth, the Rumble Live Stream API URL, the Buzzsprout key) would " +
      "have to be re-authorised by hand, and YouTube OAuth in testing mode needs " +
      "a browser consent round-trip.\n\n" +
      "If you genuinely mean it:\n" +
      `  I_UNDERSTAND_THIS_DESTROYS_PRODUCTION_DATA="${OVERRIDE_PHRASE}" npm run ${operation}\n`,
  };
}

function isProduction(value: string | null): boolean {
  if (!value) return false;
  return /^prod/i.test(value.trim());
}

/** Throw unless the operation is permitted. Used by the scripts themselves. */
export async function requireDestructiveAllowed(operation: string): Promise<void> {
  const verdict = evaluateGuard(await readGuardContext(), operation);
  if (!verdict.allowed) throw new DestructiveOperationRefused(verdict.reason);
}
