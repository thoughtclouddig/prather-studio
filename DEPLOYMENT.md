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

1. **Import the repository** into a Replit App.

2. **Attach PostgreSQL** (Tools → Database). Replit sets `DATABASE_URL`
   automatically. Nothing else is needed.

3. **Add Secrets** (Tools → Secrets) — never commit these:

   | Secret | Notes |
   |---|---|
   | `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `SEED_OWNER_EMAIL` | first OWNER account |
   | `SEED_OWNER_PASSWORD` | change after first sign-in |
   | `SEED_EDITOR_EMAIL` | optional |
   | `SEED_EDITOR_PASSWORD` | optional |

   Deployment secrets are separate from workspace secrets on Replit. Set them in
   both, or the deployed app will fail to boot on `SESSION_SECRET`.

4. **Create the schema**, once, from the workspace shell:

   ```bash
   npm run db:migrate
   ```

5. **Seed demo data** (optional — Phase 1 only, so the interface can be walked):

   ```bash
   npm run db:seed
   ```

   `db:seed` truncates every table, including `sessions`. Everyone is signed out.

6. **Deploy.** Deployments pane → **Reserved VM** → *Web server*. The build and
   run commands come from `.replit`:

   ```toml
   [deployment]
   build = ["npm", "run", "build"]
   run   = ["npm", "run", "start:production"]
   ```

   The pane writes `deploymentTarget` itself. Replit's public docs do not
   publish the exact enum for Reserved VM, so pick the type in the pane rather
   than trusting the value committed in `.replit`.

## Verifying a deployment

1. `/login` returns 200 and `/studio` returns a redirect when signed out.
2. Sign in, open **Jobs**, press **Run ping** — it reaches `SUCCEEDED` within a
   few seconds. That single check proves web → database → worker → database.
3. Press **Run fail-test** and watch it go `FAILED` → `FAILED` → `DEAD` over
   about ten seconds, then **Retry** it.

If ping never leaves `PENDING`, the worker is not running: check the deployment
logs for the `worker.start` line.

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
