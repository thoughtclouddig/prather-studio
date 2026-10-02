#!/usr/bin/env node
/**
 * Production entrypoint.
 *
 * Starts the Next.js server and the job worker as two child processes under one
 * supervisor, so the whole Studio is a single Replit Reserved VM deployment.
 *
 * Why one deployment rather than two:
 *   · A Reserved VM never sleeps, so the worker is genuinely always-on. An
 *     Autoscale instance can be recycled between requests, which is exactly the
 *     failure mode a job queue must not inherit.
 *   · Two deployments would mean two apps, two secret sets and two things to
 *     keep in sync, for an internal tool with two users. Not worth it yet.
 *   · Split them later by running `npm start` in one app and `npm run worker`
 *     in another; nothing in the code assumes they share a process.
 *
 * If either child exits, the supervisor exits non-zero so the platform restarts
 * the VM cleanly rather than leaving a half-running Studio.
 *
 * MIGRATIONS RUN FIRST, and a failure here aborts the boot.
 *
 * A fresh Replit Postgres comes up empty. Without this the web app would start,
 * answer requests, and fail on every query against tables that do not exist --
 * which looks like an application bug rather than a database that was never
 * set up. Failing loudly before anything serves traffic is the difference
 * between "deploy failed, here is why" and an hour of confused debugging.
 *
 * Drizzle's migrator records applied migrations in its own table, so this is
 * idempotent: every subsequent boot is a no-op. A Reserved VM is a single
 * instance, so there is no concurrent-migration race to guard against.
 */
import { spawn } from "node:child_process";

const children = [];
let shuttingDown = false;

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), proc: "supervisor", message, ...extra }));
}

function start(name, command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  children.push({ name, child });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log("child_exited", { name, code, signal });
    shutdown(code === 0 ? 1 : (code ?? 1));
  });

  child.on("error", (error) => {
    log("child_error", { name, error: error.message });
    shutdown(1);
  });

  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting_down", { exitCode });

  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give the worker a moment to finish the job it holds, then leave.
  setTimeout(() => process.exit(exitCode), 6000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

/** Run migrations to completion before anything serves traffic. */
function migrate() {
  return new Promise((resolve, reject) => {
    log("migrating");
    const child = spawn("npx", ["tsx", "--tsconfig", "worker/tsconfig.json", "src/db/migrate.ts"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrations exited ${code}`)),
    );
    child.on("error", reject);
  });
}

const port = process.env.PORT ?? "3000";

// Fail fast on missing configuration rather than surfacing it as a runtime
// error on the first request. These are the three the Studio cannot start
// without; provider credentials are entered through the UI and are not here.
const REQUIRED = ["DATABASE_URL", "CREDENTIAL_ENCRYPTION_KEY", "SESSION_SECRET"];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  log("missing_secrets", { missing });
  console.error(
    `\nCannot start: ${missing.join(", ")} not set.\n` +
      "Add them in Replit's Secrets pane. See DEPLOYMENT.md.\n",
  );
  process.exit(1);
}

log("starting", { port });

try {
  await migrate();
  log("migrated");
} catch (error) {
  log("migration_failed", { error: error.message });
  console.error(
    "\nCannot start: database migrations failed.\n" +
      "The app is NOT serving traffic, on purpose -- an unmigrated database " +
      "would fail every query and look like an application bug.\n",
  );
  process.exit(1);
}

start("web", "npx", ["next", "start", "-p", port, "-H", "0.0.0.0"]);
start("worker", "npx", ["tsx", "--tsconfig", "worker/tsconfig.json", "worker/index.ts"]);
