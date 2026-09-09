import type { ReactNode } from "react";
import type { Tone } from "@/lib/domain/vocabulary";

export function StateBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`state state-${tone}`}>{label}</span>;
}

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || eyebrow || actions) && (
        <header className="panel-head">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && (
              <div className="text-[13px] font-bold tracking-tight truncate">{title}</div>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 flex-none">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-[12px] text-[var(--color-type-lo)]">
      {children}
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1">{label}</div>
      <div className="text-[13px] text-[var(--color-type-hi)]">{value}</div>
    </div>
  );
}

/** Marks anything that does not touch a real platform. Used everywhere a
 *  simulated action appears, so it can never be mistaken for a live publish. */
export function SimTag() {
  return <span className="tag tag-sim">Simulated</span>;
}
