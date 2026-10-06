import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

// No database, real processes, credentials, or provider requests are used.
const source = (await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8"))
  .replace(/^#!.*\n/, "")
  .replace(/^import .*;\n/gm, "");

async function boot({ webFails = false } = {}) {
  const calls = [];
  const exits = [];
  const process = new EventEmitter();
  process.env = {
    NODE_ENV: "production",
    DATABASE_URL: "test-placeholder",
    CREDENTIAL_ENCRYPTION_KEY: "test-placeholder",
    SESSION_SECRET: "test-placeholder",
  };
  process.exit = code => exits.push(code);
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
  await vm.runInNewContext(`(async () => { ${source}\n })()`, context);
  return { calls, exits };
}

test("production starts web and worker without replaying schema migrations", async () => {
  const { calls, exits } = await boot();
  assert.deepEqual(calls.map(call => call.args[0]), ["next", "tsx"]);
  assert.equal(calls[0].args[1], "start");
  assert.equal(calls[1].args.at(-1), "worker/index.ts");
  assert.ok(calls.every(call => !call.args.includes("src/db/migrate.ts")));
  assert.deepEqual(exits, []);
});

test("a failed web startup does not start a worker", async () => {
  const { calls, exits } = await boot({ webFails: true });
  assert.deepEqual(calls.map(call => call.args[0]), ["next"]);
  assert.ok(exits.includes(1));
});
