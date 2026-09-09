# The Prather Point — Studio

Production control desk for The Prather Point / JP Intel.

**Phase 1: the internal operating skeleton.** No platform integration is
connected. Every publish action in this build is simulated and labelled as such.

## The two rules

1. **One episode.** An episode exists once. Platforms get
   `episode_publications` rows — never their own copy of the episode.
2. **AI prepares, a human approves.** Generated copy lands in
   `episode_content_drafts` as `PROPOSED`. There is no code path from a proposed
   draft to a platform.

## Quick start

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and SESSION_SECRET
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:3000
npm run worker                # in a second terminal
```

Seeded sign-in comes from `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`.

## Layout

```
src/db/schema.ts          canonical schema — 10 tables, no speculative ones
src/lib/auth/             scrypt passwords, DB sessions, the authorize() table
src/lib/queue/            Postgres job queue + the three handlers
src/lib/domain/           episodes, drafts, publications, activity, vocabulary
src/app/studio/           the Studio: dashboard, episodes, workspace, review,
                          jobs, integrations, settings
worker/index.ts           the always-on worker process
tests/                    40 tests over the invariants that matter
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Studio in dev mode |
| `npm run worker` | job worker |
| `npm test` | test suite (needs `prather_studio_test`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | new migration from schema changes |
| `npm run db:migrate` | apply migrations |
| `npm run db:seed` | reset and reseed demo data — **truncates everything** |

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md). One Replit Reserved VM runs both the web
app and the worker.

## Not in this build

Public site · WordPress import · YouTube, Rumble, Buzzsprout, Mailchimp,
OpusClip, Locals and StreamYard integrations · OAuth · transcripts · Claude
calls · clips · analytics · media ingest · external publishing.

Architecture and the platform capability audit behind these choices:
[docs/ARCHITECTURE-AUDIT.md](./docs/ARCHITECTURE-AUDIT.md).
