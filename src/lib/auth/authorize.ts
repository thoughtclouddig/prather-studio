/**
 * Authorization.
 *
 * One table, checked server-side, on every mutation. UI may hide a control for
 * tidiness but hiding is never the enforcement — `authorize()` is.
 */
import type { UserRole } from "@/db/schema";

export const ACTIONS = [
  "episode.create",
  "episode.edit",
  "episode.delete",
  "draft.edit",
  "draft.approve",
  "draft.reject",
  "publication.intent",
  "publication.enqueue",
  "job.retry",
  "settings.edit",
  "integration.configure",
  "user.manage",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * EDITOR runs the show: they create and edit episodes, approve or reject
 * packaging, set publication intent and enqueue work.
 *
 * EDITOR deliberately cannot manage users, configure integration credentials,
 * change publishing defaults, or permanently delete an episode — the four
 * actions that are either irreversible or that hand out reach.
 */
const PERMISSIONS: Record<UserRole, ReadonlySet<Action>> = {
  OWNER: new Set(ACTIONS),
  EDITOR: new Set<Action>([
    "episode.create",
    "episode.edit",
    "draft.edit",
    "draft.approve",
    "draft.reject",
    "publication.intent",
    "publication.enqueue",
    "job.retry",
  ]),
};

export class AuthorizationError extends Error {
  readonly action: Action;
  readonly role: UserRole;
  constructor(action: Action, role: UserRole) {
    super(`Role ${role} is not permitted to perform ${action}.`);
    this.name = "AuthorizationError";
    this.action = action;
    this.role = role;
  }
}

export function can(role: UserRole, action: Action): boolean {
  return PERMISSIONS[role].has(action);
}

/** Throws unless the role may perform the action. */
export function authorize(role: UserRole, action: Action): void {
  if (!can(role, action)) throw new AuthorizationError(action, role);
}

export function allowedActions(role: UserRole): Action[] {
  return ACTIONS.filter((a) => can(role, a));
}
