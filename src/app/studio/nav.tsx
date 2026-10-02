"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  exact,
  children,
}: {
  href: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={[
        "flex items-center px-3.5 text-[11px] font-bold uppercase tracking-[0.1em] whitespace-nowrap border-b-2 transition-colors",
        active
          ? "border-[var(--color-brand-red)] text-[var(--color-type-hi)]"
          : "border-transparent text-[var(--color-type-lo)] hover:text-[var(--color-type-hi)]",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
