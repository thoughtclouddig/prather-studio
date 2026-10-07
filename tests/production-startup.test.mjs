import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

// No database, real processes, credentials, or provider requests are used.
const source = (await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8"))
  .replace(/^#!.*\n/, "")
  .replace(/^import .*;\n/gm, "");

async function boot({ webFails = false, migrationFails = false, haltOnExit = false } = {}) {
  const calls = [];
  const exits = [];
  const process = new EventEmitter();
  process.env = {
    NODE_ENV: "production",
    DATABASE_URL: "test-placeholder",
    CREDENTIAL_ENCRYPTION_KEY: "test-placeholder",
    SESSION_SECRET: "test-placeholder",
  };
  // The real process.exit() stops execution. A fake that only records lets the
  // script run on past an abort it should never have survived — which is how a
  // "migrations failed, do not serve traffic" test can pass while the fake
  // happily starts the web server anyway.
  const Exit = class extends Error {};
  process.exit = code => {
    exits.push(code);
    // Only the abort paths need execution actually stopped. Throwing on the
    // shutdown path instead escapes through the supervisor's own async chain
    // and lands on the runner after the test has finished.
    if (haltOnExit) throw new Exit();
  };
  const context = {
    process,
    console: { log() {}, error() {} },
    setTimeout(callback) {
      queueMicrotask(callback);
      return { unref() {} };
    },
    spawn(command, args) {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; };
      if (args.includes("src/db/migrate.ts")) {
        queueMicrotask(() => {
          child.exitCode = migrationFails ? 1 : 0;
          child.emit("exit", migrationFails ? 1 : 0);
        });
        return child;
      }
      if (webFails && args[0] === "next") {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit("exit", 1);
        });
      }
      return child;
    },
    connect() {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
  try {
    await vm.runInNewContext(`(async () => { ${source}\n })()`, context);
  } catch (error) {
    if (error?.constructor?.name !== "Exit") throw error;
  } finally {
    // Only halt execution while the boot is being observed. A supervisor timer
    // firing after the test has ended would otherwise throw into the runner.
    process.exit = code => exits.push(code);
  }
  // Let the supervisor's own queued work drain before the test ends, or the
  // runner attributes it to a test that has already finished.
  await new Promise(resolve => setImmediate(resolve));
  return { calls, exits };
}

/**
 * Migrations run FIRST, then web, then the worker.
 *
 * This file previously asserted the opposite — that migrations are never
 * replayed — after the step was removed on the reasoning that Replit's Publish
 * flow owns the schema. The hazard behind that was real: a schema pushed
 * outside Drizzle leaves the journal behind, and a replay then fails on a
 * column that already exists. But removing the step did not fix it, it only
 * meant schema changes never reached production — four migrations went
 * unapplied and the pages needing those columns would have failed on arrival.
 *
 * The replay hazard belongs in the migrations, which are written to be
 * idempotent. The ORDER is what this file protects.
 */
test("migrations run before anything serves traffic, then web, then worker", async () => {
  const { calls, exits } = await boot();
  assert.deepEqual(calls.map(call => call.args[0]), ["tsx", "next", "tsx"]);
  assert.ok(calls[0].args.includes("src/db/migrate.ts"));
  assert.equal(calls[1].args[1], "start");
  assert.equal(calls[2].args.at(-1), "worker/index.ts");
  assert.deepEqual(exits, []);
});

test("a failed migration aborts the boot and never serves traffic", async () => {
  // An unmigrated database fails every query and reads as an application bug.
  // Refusing to start is the difference between "deploy failed, here is why"
  // and an hour of confused debugging.
  const { calls, exits } = await boot({ migrationFails: true, haltOnExit: true });
  assert.deepEqual(calls.map(call => call.args[0]), ["tsx"]);
  assert.ok(exits.includes(1));
});

test("a failed web startup does not start a worker", async () => {
  const { calls, exits } = await boot({ webFails: true });
  assert.deepEqual(calls.map(call => call.args[0]), ["tsx", "next"]);
  assert.ok(exits.includes(1));
});
