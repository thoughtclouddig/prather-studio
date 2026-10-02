/**
 * Create (or reset) the first OWNER account. Production-safe.
 *
 * ## Why this exists separately from `db:seed`
 *
 * `db:seed` is a DEVELOPMENT fixture: it deletes every table and writes demo
 * episodes, drafts, dead jobs and activity written in the show's register. That
 * is exactly right for judging the workflow on a laptop and exactly wrong on
 * the real podcast's database — a Phase 1 fixture that reaches production is an
 * episode somebody has to notice and delete, and four of them already had to be
 * removed once.
 *
 * But a fresh deployment still needs one account to sign in with, or the Studio
 * is unreachable. So: this writes exactly one row and touches nothing else.
 *
 * ## Idempotent on purpose
 *
 * Re-running it updates the existing account's password and role rather than
 * failing on the unique index. That makes it the password-reset path too, which
 * matters when the only OWNER is locked out and there is no other way in.
 *
 *   npm run bootstrap:owner
 *   npm run bootstrap:owner -- --email jp@jpintel.com --name "Jeffrey Prather"
 *
 * The password comes from OWNER_PASSWORD or SEED_OWNER_PASSWORD, or is
 * generated and printed once. It is never logged on an update unless generated.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { eq, sql as raw } from "drizzle-orm";
import { hashPassword } from "../lib/auth/password";
import { db, sql } from "./client";
import { users } from "./schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (
    arg("email") ??
    process.env.OWNER_EMAIL ??
    process.env.SEED_OWNER_EMAIL ??
    ""
  ).trim();

  if (!email) {
    console.error(
      "\nNo email given.\n" +
        "  npm run bootstrap:owner -- --email you@example.com\n" +
        "or set OWNER_EMAIL / SEED_OWNER_EMAIL.\n",
    );
    process.exit(1);
  }

  const name = arg("name") ?? process.env.OWNER_NAME ?? email.split("@")[0]!;

  // A generated password is printed; a supplied one never is.
  const supplied = arg("password") ?? process.env.OWNER_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;
  const generated = supplied ? null : randomBytes(12).toString("base64url");
  const password = supplied ?? generated!;

  const passwordHash = await hashPassword(password);
  const now = new Date();

  // Look up by the same case-insensitive rule the unique index uses, then
  // update or insert. Done explicitly rather than as an upsert because the
  // index is on `lower(email)`, which is an expression rather than a column —
  // and an upsert that silently misses the conflict target would fail on the
  // index instead of resetting the password, which is the one thing this
  // script must never do to someone locked out.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(raw`lower(${users.email}) = lower(${email})`)
    .limit(1);

  const [row] = existing
    ? await db
        .update(users)
        .set({ passwordHash, role: "OWNER", name, updatedAt: now })
        .where(eq(users.id, existing.id))
        .returning({ id: users.id, email: users.email, role: users.role })
    : await db
        .insert(users)
        .values({ email, name, role: "OWNER", passwordHash })
        .returning({ id: users.id, email: users.email, role: users.role });

  const total = await db.select({ n: raw<number>`count(*)::int` }).from(users);

  console.log("");
  console.log(`  OWNER ${existing ? "updated" : "created"} : ${row!.email}`);
  console.log(`  id          : ${row!.id}`);
  console.log(`  users total : ${total[0]?.n ?? "?"}`);
  if (generated) {
    console.log("");
    console.log(`  PASSWORD    : ${generated}`);
    console.log("  Shown once. Save it now, then change it after signing in.");
  } else {
    console.log("  password    : (the one you supplied — not printed)");
  }
  console.log("");

  await sql.end();
}

main().catch(async (error) => {
  console.error("[bootstrap-owner] failed:", error instanceof Error ? error.message : error);
  try {
    await sql.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
