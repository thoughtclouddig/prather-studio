# Deploying the Studio on Replit

## Shape

**One Replit App. One Reserved VM deployment. Two processes.**

```
Replit App: prather-studio
└── Reserved VM deployment  (never sleeps)
    └── node scripts/start-production.mjs      ← supervisor
        ├── next start -p $PORT -H 0.0.0.0     ← the Studio UI
        └── tsx worker/index.ts                ← the job worker
    └── Replit PostgreSQL  (DATABASE_URL)
```

## Why a Reserved VM and not Autoscale

Autoscale is Replit's default and it is the right choice for most web apps: it
scales to zero and you pay for traffic. It is the wrong choice here.

An Autoscale instance can be recycled between requests. A job worker that gets
recycled mid-job leaves rows stuck in `RUNNING`, and long work — a transcript
pull, a video upload — simply does not survive. A Reserved VM never sleeps, so
the worker is genuinely resident.

The Studio has two users and negligible traffic, so Autoscale's cost advantage
is worth nothing here, and its execution model actively costs us reliability.

## Why one deployment and not two

Two deployments would mean two Replit Apps, two secret sets and two things to
keep in version-sync, for an internal tool operated by two people. The
supervisor in `scripts/start-production.mjs` starts both processes and exits
non-zero if either one dies, so the platform restarts a clean VM rather than
leaving half a Studio running.

Nothing in the code assumes they share a process. To split them later: run
`npm start` in one app and `npm run worker` in another, pointed at the same
`DATABASE_URL`. No code change.

## Setup

Ordered for a cold start. Steps 1-4 take about ten minutes; step 5 is the one
people forget and it is the one that breaks YouTube.

### 1. Import the repository into a Replit App

Branch `phase-3-automation-buzzsprout` until it merges to `main`.

### 2. Attach PostgreSQL

**Tools → Database.** Replit sets `DATABASE_URL` itself. Nothing else to do.

**You do not need to create the schema.** `start:production` runs migrations
before it serves a single request, and aborts the boot if they fail. An
unmigrated database would fail every query and look like an application bug, so
it fails loudly instead.

### 3. Add Secrets

**Tools → Secrets.** Replit keeps *workspace* and *deployment* secrets
separately — **set them in both**, or the deployed app boots, finds nothing, and
exits.

| Secret | Where it comes from |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | **Already generated — copy from local `.env`.** Every stored provider credential is AES-256-GCM encrypted with it. Losing it does not lose data, but every connection must be re-authorized. Back it up somewhere other than the database. |
| `SESSION_SECRET` | Already in local `.env`. Or regenerate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `YOUTUBE_CLIENT_ID` | Already in local `.env` — the Google Cloud OAuth client is unchanged. |
| `YOUTUBE_CLIENT_SECRET` | Same. |
| `ANTHROPIC_API_KEY` | `console.anthropic.com`. Without it everything else works and the content engine reports that it cannot run. |
| `APP_BASE_URL` | The deployed origin, e.g. `https://prather-studio.replit.app`. **No trailing slash.** This builds the OAuth redirect URI, so a wrong value fails the YouTube connect with a mismatch. |
| `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` | The first OWNER account. Change the password after first sign-in. |

The Rumble key and the Buzzsprout token are **not** secrets here — they are
per-account data entered through Integrations, encrypted at rest, and rotatable
without a redeploy.

### 4. Deploy

**Deployments → Reserved VM → Web server.** Build and run come from `.replit`:

```toml
[deployment]
build = ["npm", "run", "build"]
run   = ["npm", "run", "start:production"]
```

Pick **Reserved VM** in the pane rather than trusting the committed
`deploymentTarget`: Replit does not publish the exact enum, and Autoscale would
recycle the instance and stall the worker.

### 5. Add the deployed redirect URI to Google — do not skip this

**console.cloud.google.com → Credentials → your OAuth client → Authorized
redirect URIs.** Add, exactly, with no trailing slash:

```
https://<your-repl>.replit.app/api/integrations/youtube/callback
```

Keep the localhost entry too, so development still works. Without this, the
YouTube connect fails with `redirect_uri_mismatch` and nothing in the Studio can
tell you why — the error happens at Google, before the request reaches us.

### 6. Sign in and connect the three providers

**Integrations**, in this order:

1. **YouTube** — Connect, and sign in as the account that owns JP INTEL. The
   consent screen lists `youtube.force-ssl` and `yt-analytics.readonly`.
2. **Rumble** — paste the key from `rumble.com/account/livestream-api`. The URL
   or the key alone both work. It is tested before it is saved.
3. **Buzzsprout** — paste the API token, leave Podcast ID blank. The podcast is
   discovered and confirmed before anything is stored.

### 7. Schedule the polls

**Scheduled Deployments** — these cannot be declared in `.replit`:

| Schedule | Command | Why |
|---|---|---|
| every 1 minute | `npm run job:rumble-poll` | Rumble emits no "finished" event; the end of a show is inferred from the stream disappearing, so the boundary is only as precise as the poll. |
| every 1 hour | `npm run job:health-check` | Surfaces an expiring YouTube token before a show, not after. |
| every 6 hours | `npm run job:metrics-snapshot` | Rumble followers and Buzzsprout plays are point-in-time counters nobody keeps. Every missed window is growth history that cannot be recovered. |

The schedule only *enqueues*; the worker executes. A slow job can never overlap
its own schedule.

## Verifying a deployment

1. `/login` returns 200; `/studio` redirects when signed out.
2. Sign in → **Jobs** → **Run ping** reaches `SUCCEEDED` within a few seconds.
   That one check proves web → database → worker → database.
3. **Integrations** shows all three `CONNECTED`, with channel name, follower
   count and podcast title — real values, not placeholders.
4. **Dashboard** shows the next show from the cadence, with a countdown.

If ping never leaves `PENDING`, the worker is not running — check the deployment
log for `worker.start`. If the boot failed on migrations or a missing secret, the
log says exactly which, and the app is deliberately not serving.

## Operational notes

- **The filesystem is not durable.** A Replit republish discards it. Everything
  that must survive goes to Postgres. When master media arrives in a later
  phase it goes to object storage, never to disk.
- **Migrations are not automatic.** `npm run db:migrate` is a deliberate manual
  step. A deployment that silently migrates is a deployment that can silently
  destroy data.
- **Stale jobs self-heal.** A worker that dies holding a job leaves it `RUNNING`;
  `reclaimStale()` requeues those on boot and every 60 seconds.
- **Staging.** When integrations arrive, staging needs its own database *and its
  own provider credentials*. Testing a publish against the live YouTube channel
  is not acceptable.

## Costs

Reserved VM starts around $15/month for the smallest machine (shared 0.5 vCPU /
2 GB), plus Postgres. The smallest machine is sufficient for two shows a week.
