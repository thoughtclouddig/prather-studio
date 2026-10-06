"use server";

import { IntakeError, recordHostSubmission } from "@/lib/domain/intake";

export interface SubmitState {
  ok?: string;
  error?: string;
}

/**
 * Jeff's submission.
 *
 * Deliberately NOT behind the Studio login. Jeff is the host, not an operator —
 * asking him to hold a password for a four-field form is how a form stops being
 * used. The protection is that a submission creates a PLANNED episode and
 * nothing else: it contacts no provider, sends no email and publishes nothing,
 * so the worst a stray submission costs is a row an operator deletes.
 *
 * INTAKE_TOKEN adds a shared secret to the URL when one is set, which keeps the
 * form one bookmark away for Jeff while deterring anything that wanders in.
 */
export async function submitShowAction(
  _prev: SubmitState | undefined,
  formData: FormData,
): Promise<SubmitState> {
  const required = process.env.INTAKE_TOKEN?.trim();
  if (required && String(formData.get("k") ?? "") !== required) {
    return { error: "This form link is not valid. Ask Andy for the current one." };
  }

  try {
    const { created } = await recordHostSubmission({
      showDate: String(formData.get("showDate") ?? ""),
      headline: String(formData.get("headline") ?? ""),
      topics: String(formData.get("topics") ?? ""),
      brief: String(formData.get("brief") ?? ""),
      notes: String(formData.get("notes") ?? ""),
    });

    return {
      ok: created
        ? "Got it — sent to Andy. He reviews everything before anything goes out."
        : "Updated today's show with your changes. Nothing has gone out yet.",
    };
  } catch (error) {
    if (error instanceof IntakeError) return { error: error.message };
    console.error("[intake] failed", error);
    return {
      error: "Something went wrong saving that. Try again, or text Andy.",
    };
  }
}
