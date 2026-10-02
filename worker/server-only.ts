/**
 * `server-only` is a BUILD-TIME guard: it makes Next.js fail the build if a
 * module is pulled into a client bundle. It works by resolving to a throwing
 * stub outside that graph — which is exactly what happens when the worker runs
 * the same shared modules under plain Node.
 *
 * The worker therefore substitutes this no-op via `worker/tsconfig.json`. The
 * web build still resolves the real package, so the guard it exists for is
 * fully intact where it matters. The tests do the same thing via a Vitest
 * alias — see `tests/stubs/server-only.ts`.
 */
export {};
