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

const port = process.env.PORT ?? "3000";
log("starting", { port });

start("web", "npx", ["next", "start", "-p", port, "-H", "0.0.0.0"]);
start("worker", "npx", ["tsx", "--tsconfig", "worker/tsconfig.json", "worker/index.ts"]);
