import { describe, expect, it } from "vitest";
import { evaluateGuard, OVERRIDE_PHRASE, type GuardContext } from "@/db/guard";
import { assessWorkers, type WorkerStatus } from "@/lib/queue/worker-registry";

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  databaseEnvironment: "development",
  processEnvironment: "development",
  overrideSupplied: false,
  ...over,
});

describe("destructive development commands", () => {
  it("runs freely against a development database", () => {
    expect(evaluateGuard(ctx(), "db:seed:dev").allowed).toBe(true);
  });

  it("runs against an unclaimed database", () => {
    expect(evaluateGuard(ctx({ databaseEnvironment: null }), "db:seed:dev").allowed).toBe(
      true,
    );
  });

  /** The real hazard: the database says production, whatever the shell says. */
  it("refuses when the DATABASE says production, even in a dev shell", () => {
    const verdict = evaluateGuard(
      ctx({ databaseEnvironment: "production", processEnvironment: "development" }),
      "db:seed:dev",
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/integration credentials/i);
  });

  it("refuses when the PROCESS declares production", () => {
    expect(
      evaluateGuard(
        ctx({ databaseEnvironment: null, processEnvironment: "production" }),
        "db:reset:dev",
      ).allowed,
    ).toBe(false);
  });

  it("recognises production-like names", () => {
    for (const name of ["production", "PRODUCTION", "prod", "Prod"]) {
      expect(evaluateGuard(ctx({ databaseEnvironment: name }), "db:seed:dev").allowed).toBe(
        false,
      );
    }
  });

  it("does not mistake 'preview' or 'staging' for production", () => {
    for (const name of ["preview", "staging", "prod-like-but-not"]) {
      const verdict = evaluateGuard(ctx({ databaseEnvironment: name }), "db:seed:dev");
      // "prod-like-but-not" starts with "prod" and IS blocked — deliberately
      // conservative. The other two must not be.
      if (name === "prod-like-but-not") expect(verdict.allowed).toBe(false);
      else expect(verdict.allowed).toBe(true);
    }
  });

  /** The override exists, but it has to be meant. */
  it("allows production only with the exact override phrase", () => {
    expect(
      evaluateGuard(
        ctx({ databaseEnvironment: "production", overrideSupplied: true }),
        "db:seed:dev",
      ).allowed,
    ).toBe(true);
    expect(OVERRIDE_PHRASE).toBe("yes destroy production data");
  });

  it("names the command in the refusal so the fix is copy-pasteable", () => {
    const verdict = evaluateGuard(
      ctx({ databaseEnvironment: "production" }),
      "db:reset:dev",
    );
    if (verdict.allowed) throw new Error("expected refusal");
    expect(verdict.reason).toContain("db:reset:dev");
    expect(verdict.reason).toContain(OVERRIDE_PHRASE);
  });
});

const worker = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({
    workerId: "w1",
    environment: "production",
    version: "abc123",
    hostname: "vm",
    pid: 1,
    startedAt: new Date(),
    lastBeatAt: new Date(),
    jobsClaimed: 0,
    rejectedReason: null,
    alive: true,
    secondsSinceBeat: 2,
    ...over,
  }) as WorkerStatus;

describe("worker health assessment", () => {
  it("one live worker on the expected version is fine", () => {
    expect(assessWorkers([worker()], "abc123").concerns).toEqual([]);
  });

  /** Exactly the Phase 2 failure: four workers, two of them stale. */
  it("flags competing live workers", () => {
    const { concerns } = assessWorkers(
      [worker({ workerId: "w1" }), worker({ workerId: "w2" })],
      "abc123",
    );
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toMatch(/2 workers are alive/);
    expect(concerns[0]).toContain("w1");
    expect(concerns[0]).toContain("w2");
  });

  it("does not flag a dead worker alongside a live one", () => {
    const { concerns } = assessWorkers(
      [worker({ workerId: "live" }), worker({ workerId: "old", alive: false })],
      "abc123",
    );
    expect(concerns).toEqual([]);
  });

  it("flags a live worker running the wrong build", () => {
    const { concerns } = assessWorkers([worker({ version: "old-build" })], "abc123");
    expect(concerns[0]).toMatch(/running version old-build/);
  });

  it("does not flag version when the deployment has no expected version", () => {
    expect(assessWorkers([worker({ version: "anything" })], null).concerns).toEqual([]);
  });

  it("surfaces a refused worker so a silent refusal is not invisible", () => {
    const { concerns } = assessWorkers(
      [worker({ alive: false, rejectedReason: "wrong environment" })],
      "abc123",
    );
    expect(concerns[0]).toMatch(/was refused: wrong environment/);
  });

  it("a refused worker is never counted as alive", () => {
    const rejected = worker({ rejectedReason: "wrong environment", alive: false });
    expect(assessWorkers([worker(), rejected], "abc123").concerns).toHaveLength(1);
  });
});
