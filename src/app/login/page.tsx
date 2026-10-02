import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./form";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/studio");

  return (
    <main className="min-h-screen grid place-items-center px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-[3px] h-7 bg-[var(--color-brand-red)]" />
            <div>
              <div className="eyebrow">The Prather Point</div>
              <div className="display text-[20px]">STUDIO</div>
            </div>
          </div>
          <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed">
            Production control desk. Authorized operators only.
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
