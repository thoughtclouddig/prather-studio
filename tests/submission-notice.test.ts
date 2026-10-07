import { describe, expect, it } from "vitest";
import { composeSubmissionNotice } from "@/lib/domain/submission-notice";

const BASE = {
  headline: "Iraq Israeli False Flag War Trap",
  topics: ["Netanyahu war cabinet split", "Iraq proxy escalation"],
  brief: "This is the trap I warned about in September.",
  notes: null,
  showDate: "Tuesday, October 7",
  episodeUrl: "https://prather-studio.replit.app/studio/episodes/abc",
  resubmitted: false,
};

describe("the submission notice", () => {
  it("carries the whole submission, so it reads on a phone without opening anything", () => {
    const { text } = composeSubmissionNotice(BASE);
    expect(text).toContain(BASE.headline);
    for (const topic of BASE.topics) expect(text).toContain(topic);
    expect(text).toContain(BASE.brief);
    expect(text).toContain(BASE.episodeUrl);
  });

  it("puts the headline in the subject, because that is what the phone shows", () => {
    expect(composeSubmissionNotice(BASE).subject).toContain(BASE.headline);
  });

  it("says when it is a resubmission rather than looking like a second show", () => {
    const first = composeSubmissionNotice(BASE);
    const again = composeSubmissionNotice({ ...BASE, resubmitted: true });
    expect(first.subject).not.toMatch(/resubmit/i);
    expect(again.subject).toMatch(/resubmit/i);
    expect(again.text).toMatch(/resubmitted/i);
  });

  it("counts the topics", () => {
    expect(composeSubmissionNotice(BASE).text).toContain("TOPICS (2)");
  });

  it("omits sections Jeff left empty rather than printing empty headings", () => {
    const bare = composeSubmissionNotice({ ...BASE, brief: null, notes: null });
    expect(bare.text).not.toContain("HIS WRITE-UP");
    expect(bare.text).not.toContain("ANYTHING ELSE");
    expect(bare.text).toContain("HEADLINE");
  });

  it("includes anything else when he used that field", () => {
    const withNotes = composeSubmissionNotice({ ...BASE, notes: "Guest may run late" });
    expect(withNotes.text).toContain("ANYTHING ELSE");
    expect(withNotes.text).toContain("Guest may run late");
  });
});
