import { SubmitForm } from "./form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Today's episode — The Prather Point",
};

/**
 * Jeff's intake, inside the Studio.
 *
 * It used to be a separate Replit app with its own database, which meant every
 * word he wrote had to be carried across by hand — and the Studio sat idle all
 * morning waiting for a transcript that cannot exist until the show has
 * happened, while the material needed to write the headlines, the email and the
 * post was already sitting in another browser tab.
 *
 * Submitting here creates the episode directly. No sync, no second database.
 */
export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string }>;
}) {
  const { k } = await searchParams;

  // Default to today in the show's zone rather than the browser's — a host in
  // Arizona and a server in UTC must offer the same date.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  return (
    <div className="min-h-dvh px-4 py-10">
      <div className="max-w-[640px] mx-auto space-y-7">
        <header>
          <div className="wordmark mb-4">The Prather Point</div>
          <h1 className="display text-[26px] mb-2">Today&rsquo;s episode</h1>
          <p className="text-[14px] text-[var(--color-type-mid)] leading-relaxed">
            Jeff &mdash; tell me about today&rsquo;s show. I&rsquo;ll turn it into headlines
            that get the click, write up your brief, and send it to Andy to review.
          </p>
        </header>

        <SubmitForm token={k ?? ""} defaultDate={today} />
      </div>
    </div>
  );
}
