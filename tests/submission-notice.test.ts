import { describe, expect, it } from "vitest";
import {
  composeSubmissionNotice,
  normalizeEmail,
} from "@/lib/domain/submission-notice";

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

describe("addresses pasted from Secrets", () => {
  it("leaves an ordinary address exactly as it is", () => {
    expect(normalizeEmail("andyrenk@gmail.com")).toBe("andyrenk@gmail.com");
    expect(normalizeEmail("andy@thoughtclouddigital.com")).toBe(
      "andy@thoughtclouddigital.com",
    );
  });

  /**
   * The whole line pasted as the value. APP_BASE_URL held its own
   * documentation line once in this project and sent a malformed redirect_uri
   * to Google; the same paste here produces Resend's "Invalid `to` field",
   * which says nothing about why either.
   */
  it("strips a pasted assignment", () => {
    expect(normalizeEmail("NOTIFY_EMAIL = andyrenk@gmail.com")).toBe("andyrenk@gmail.com");
    expect(normalizeEmail("NOTIFY_EMAIL=andyrenk@gmail.com")).toBe("andyrenk@gmail.com");
  });

  it("strips quotes and whitespace", () => {
    expect(normalizeEmail('  "andyrenk@gmail.com"  ')).toBe("andyrenk@gmail.com");
    expect(normalizeEmail("'andyrenk@gmail.com'")).toBe("andyrenk@gmail.com");
  });

  it("keeps a display name, which Resend accepts", () => {
    expect(normalizeEmail("Andy <andy@example.com>")).toBe("Andy <andy@example.com>");
  });

  it("refuses something that is not an address, so the error names the cause", () => {
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("andy@localhost")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});
