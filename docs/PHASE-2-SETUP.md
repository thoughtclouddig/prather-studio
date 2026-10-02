# Phase 2 setup — connecting the real show

Everything in Phase 2 is built. Three credentials are needed to run it against
the live channel, and all three have to come from you — none can be created
from inside the Studio.

---

## 1. YouTube OAuth client (required)

The Studio talks to YouTube as *your* application, so it needs an OAuth client
of its own.

1. **Google Cloud Console** → create a project (or reuse one).
2. **APIs & Services → Library** → enable both:
   - **YouTube Data API v3**
   - **YouTube Analytics API**
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Add the Google account that owns/manages the JP Intel channel as a **Test
     user**. While the app is in Testing, only listed test users can authorize
     it — which is what we want.
   - Add both scopes (see §1.1 below).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI — exactly this, no trailing slash:
     ```
     http://localhost:3000/api/integrations/youtube/callback
     ```
     Add the deployed origin too when the Studio goes on Replit:
     ```
     https://<your-repl>.replit.app/api/integrations/youtube/callback
     ```
5. Copy the client ID and client secret into Secrets:
   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   APP_BASE_URL=http://localhost:3000
   ```
6. In the Studio: **Integrations → Connect YouTube**, and sign in as the account
   that owns the channel.

### 1.1 The scopes, and why each one

Verified against the current API reference, not assumed:

| Scope | Why |
|---|---|
| `youtube.force-ssl` | The only scope that satisfies all four methods we need: `videos.list`, `videos.update`, `captions.list` and `captions.download`. It also covers `thumbnails.set`. |
| `yt-analytics.readonly` | Read-only analytics. Requested now purely so we don't have to re-consent on a production channel later. |

**The Phase 1 report's proposed scope set was wrong** and this corrects it.
`captions.download` accepts only `youtube.force-ssl` or `youtubepartner` — the
narrower `youtube.upload` + `youtube.readonly` set would have failed with a 403
at exactly the step that matters most.

`youtube.upload` is **deliberately not requested**. Phase 2 updates the existing
video and never creates a second copy of a show. `force-ssl` does not grant
`videos.insert`, so adding upload later requires a fresh consent — which is the
correct friction.

---

## 2. Rumble Live Stream API URL (required for the observer)

1. Sign in to Rumble as Jeffrey → <https://rumble.com/account/livestream-api>
2. Generate the URL and copy it.
3. In the Studio: **Integrations → Rumble → Test & connect**.

The Studio tests it before saving, and stores it **encrypted** — the URL
contains the key, so it is the credential. It is never displayed again.

This is not an environment variable, on purpose: it is per-account data that an
operator should be able to rotate without a redeploy.

**What Rumble can and cannot do**, so the observer's limits are not a surprise:

| | |
|---|---|
| ✅ Report whether a stream is live right now, its ID, title, viewer count, likes, chat and rants | |
| ✅ Report follower and subscriber totals | |
| ❌ List past videos · retrieve a recording · edit metadata · upload · webhooks | |

`livestreams` is populated **only while live** — Rumble emits no "finished"
event. The end of a show is therefore inferred from the stream disappearing,
which is why the poll runs on a schedule.

---

## 3. Anthropic API key (required for the content engine)

```
ANTHROPIC_API_KEY=sk-ant-...
```

Powers `episode.package`. Without it, everything else works and the content
engine reports that it cannot run.

---

## 4. Encryption key (required, generate once)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```
CREDENTIAL_ENCRYPTION_KEY=<the 32-byte value>
```

Every stored provider credential is AES-256-GCM encrypted with this key.
**Back it up somewhere other than the database.** Losing it does not lose data,
but every connection has to be re-authorized.

---

## 5. Scheduled jobs (Replit)

The worker executes jobs; the schedule only enqueues them, so a slow job can
never overlap its own schedule.

In Replit's **Scheduled Deployments** pane:

| Schedule | Command |
|---|---|
| every 1 minute | `npm run job:rumble-poll` |
| every 1 hour | `npm run job:health-check` |

Locally you can just run them by hand:

```bash
npm run job:rumble-poll
```

---

## Verifying the connection

1. **Integrations** — YouTube shows `CONNECTED` with the channel name and ID.
2. Open an episode → **Find video**. Recent uploads appear ranked, with reasons.
3. Confirm one → the video ID and URL are stored.
4. **Retrieve transcript** → watch it on the Jobs page.
5. **Run content engine** → proposals appear in Review.
6. Approve them → **Review diff** → **Update YouTube**.

If step 4 fails with a 403, that is the experiment the Phase 0 audit flagged.
The exact API response is written to the episode's Activity — send it over
rather than working around it, because it decides whether the transcript path
stays on YouTube or moves to transcribing our own master.
