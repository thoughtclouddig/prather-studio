import Link from "next/link";
import { requireUser } from "@/lib/auth/require";
import { signOut } from "@/app/login/actions";
import { NavLink } from "./nav";

const NAV = [
  { href: "/studio", label: "Dashboard", exact: true },
  { href: "/studio/episodes", label: "Episodes" },
  { href: "/studio/jobs", label: "Jobs" },
  { href: "/studio/integrations", label: "Integrations" },
  { href: "/studio/settings", label: "Settings" },
];

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--color-ink-200)] bg-[var(--color-ink-050)] sticky top-0 z-20">
        <div className="flex items-center gap-4 px-4 h-12">
          <Link href="/studio" className="flex items-center gap-2.5 flex-none">
            <span className="w-[3px] h-6 bg-[var(--color-brand-red)]" />
            <span className="display text-[13px] tracking-tight">
              PRATHER<span className="text-[var(--color-type-lo)]">·</span>STUDIO
            </span>
          </Link>

          <nav className="flex items-stretch gap-0 overflow-x-auto h-12 -my-0">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} exact={item.exact}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 flex-none">
            <div className="text-right hidden sm:block leading-tight">
              <div className="text-[12px] font-semibold">{user.name}</div>
              <div className="eyebrow">{user.role}</div>
            </div>
            <form action={signOut}>
              <button className="btn btn-ghost btn-xs" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 py-5 max-w-[1500px] w-full mx-auto">{children}</main>

      <footer className="border-t border-[var(--color-ink-200)] px-4 py-2.5">
        {/* This line has to track reality. It said Buzzsprout and WordPress
            had no adapter while both were connected and working, which is
            exactly the kind of stale copy that teaches an operator to stop
            reading the interface. */}
        <p className="mono text-[10px]">
          Real adapters: YouTube (read &amp; write), Rumble (observed only &mdash; no
          upload, no metadata write), Buzzsprout, WordPress (drafts only). Mailchimp,
          OpusClip and Locals have no adapter yet; their publish actions are simulated
          and labelled as such.
        </p>
      </footer>
    </div>
  );
}
