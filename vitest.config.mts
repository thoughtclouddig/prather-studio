import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    // Tests run against a real Postgres — the queue relies on FOR UPDATE SKIP
    // LOCKED and unique constraints, neither of which a mock would exercise.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres@127.0.0.1:55432/prather_studio_test",
      SESSION_SECRET: "test-secret-not-used-for-anything-real",
      NODE_ENV: "test",
    },
    globals: false,
    // Tests share one Postgres database and truncate between cases, so they
    // must not run concurrently.
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when imported outside a React Server Component.
      // It is a build-time guard for Next.js; the tests exercise the same
      // modules directly, so it is stubbed rather than removed from the source.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
});
