import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@/db/schema";
import { getCurrentUser } from "./session";
import { authorize, type Action } from "./authorize";

/** For pages and server actions: a signed-in user, or a redirect to /login. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For server actions: a signed-in user who may perform `action`. */
export async function requirePermission(action: Action): Promise<User> {
  const user = await requireUser();
  authorize(user.role, action);
  return user;
}
