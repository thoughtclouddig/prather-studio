import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  AuthorizationError,
  allowedActions,
  authorize,
  can,
} from "@/lib/auth/authorize";

describe("authorization", () => {
  it("OWNER may perform every action", () => {
    for (const action of ACTIONS) {
      expect(can("OWNER", action), `OWNER should be allowed ${action}`).toBe(true);
    }
  });

  it("EDITOR may run the show", () => {
    for (const action of [
      "episode.create",
      "episode.edit",
      "draft.edit",
      "draft.approve",
      "draft.reject",
      "publication.intent",
      "publication.enqueue",
      "job.retry",
    ] as const) {
      expect(can("EDITOR", action), `EDITOR should be allowed ${action}`).toBe(true);
    }
  });

  /**
   * The four actions an EDITOR must never reach: they are either irreversible
   * or they hand out reach. If this test ever goes green for EDITOR, the role
   * boundary has been lost.
   */
  it("EDITOR may not delete episodes, manage users, or touch credentials", () => {
    for (const action of [
      "episode.delete",
      "user.manage",
      "integration.configure",
      "settings.edit",
    ] as const) {
      expect(can("EDITOR", action), `EDITOR must NOT be allowed ${action}`).toBe(false);
    }
  });

  it("authorize() throws AuthorizationError naming the action and role", () => {
    expect(() => authorize("EDITOR", "user.manage")).toThrow(AuthorizationError);
    try {
      authorize("EDITOR", "user.manage");
    } catch (error) {
      const e = error as AuthorizationError;
      expect(e.action).toBe("user.manage");
      expect(e.role).toBe("EDITOR");
    }
    expect(() => authorize("OWNER", "user.manage")).not.toThrow();
  });

  it("every declared action is decidable for both roles", () => {
    expect(allowedActions("OWNER")).toHaveLength(ACTIONS.length);
    expect(allowedActions("EDITOR").length).toBeLessThan(ACTIONS.length);
  });
});
