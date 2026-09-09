import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeContentDrafts, episodes, type User } from "@/db/schema";
import { approveDraft, editAndApproveDraft, rejectDraft } from "@/lib/domain/drafts";
import { AuthorizationError } from "@/lib/auth/authorize";
import { makeEpisode, makeShow, makeUser, resetDb } from "./helpers";

let owner: User;
let episodeId: string;

async function seedDraft(field = "primary_headline", value = "Proposed headline") {
  const [draft] = await db
    .insert(episodeContentDrafts)
    .values({ episodeId, field, value, source: "AI", state: "PROPOSED" })
    .returning();
  return draft!;
}

beforeEach(async () => {
  await resetDb();
  owner = await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
});

describe("content approval", () => {
  it("PROPOSED → APPROVED records who approved and when", async () => {
    const draft = await seedDraft();
    const approved = await approveDraft(owner, draft.id);

    expect(approved.state).toBe("APPROVED");
    expect(approved.approvedBy).toBe(owner.id);
    expect(approved.approvedAt).not.toBeNull();
  });

  it("PROPOSED → REJECTED", async () => {
    const draft = await seedDraft();
    const rejected = await rejectDraft(owner, draft.id, "off-voice");
    expect(rejected.state).toBe("REJECTED");
  });

  /**
   * The invariant that keeps AI copy off platforms: only PROPOSED drafts move.
   * An already-decided draft cannot be flipped by a stale form submission.
   */
  it("refuses to approve or reject a draft that is already decided", async () => {
    const draft = await seedDraft();
    await approveDraft(owner, draft.id);

    await expect(approveDraft(owner, draft.id)).rejects.toThrow(/PROPOSED/);
    await expect(rejectDraft(owner, draft.id)).rejects.toThrow(/PROPOSED/);
  });

  it("approving the primary headline sets the episode's approved title", async () => {
    const draft = await seedDraft("primary_headline", "Five Bases Hit");
    const [before] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(before?.approvedTitle).toBeNull();

    await approveDraft(owner, draft.id);

    const [after] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(after?.approvedTitle).toBe("Five Bases Hit");
  });

  it("rejecting the only approved headline clears the approved title again", async () => {
    const draft = await seedDraft("primary_headline", "Five Bases Hit");
    await approveDraft(owner, draft.id);

    const second = await seedDraft("primary_headline", "Another headline");
    await rejectDraft(owner, second.id);

    const [after] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(after?.approvedTitle).toBe("Five Bases Hit");
  });

  /**
   * Edit-and-approve must preserve what the model actually proposed. If the
   * original were overwritten there would be no audit trail at all.
   */
  it("edit-and-approve supersedes the original rather than overwriting it", async () => {
    const draft = await seedDraft("primary_headline", "Model's version");
    const replacement = await editAndApproveDraft(owner, draft.id, "Operator's version");

    expect(replacement.state).toBe("APPROVED");
    expect(replacement.source).toBe("HUMAN");
    expect(replacement.value).toBe("Operator's version");

    const [original] = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.id, draft.id));

    expect(original?.state).toBe("SUPERSEDED");
    expect(original?.value).toBe("Model's version");
    expect(original?.supersededById).toBe(replacement.id);

    const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(ep?.approvedTitle).toBe("Operator's version");
  });

  it("rejects empty edited content", async () => {
    const draft = await seedDraft();
    await expect(editAndApproveDraft(owner, draft.id, "   ")).rejects.toThrow(/empty/);
  });

  it("a role without draft.approve cannot approve", async () => {
    const draft = await seedDraft();
    const stranger = { ...owner, role: "VIEWER" as never };
    await expect(approveDraft(stranger, draft.id)).rejects.toThrow();
  });

  it("EDITOR may approve", async () => {
    const editor = await makeUser("EDITOR");
    const draft = await seedDraft();
    const approved = await approveDraft(editor, draft.id);
    expect(approved.state).toBe("APPROVED");
    expect(AuthorizationError.name).toBe("AuthorizationError");
  });
});
