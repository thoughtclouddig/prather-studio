# Phase 3 — provider investigation

Findings that had to come **before** code. Everything here is from live provider
data pulled on 2026-09-14; the probe scripts are in `scripts/investigate-*.ts`
and are read-only.

---

## 1. The duplicate YouTube videos — solved

**Both copies are livestreams. Neither is a re-upload.**

`videos.list(part=fileDetails)` — owner-only — returns for all four:

```
fileName: "livestream.str"    container: webm    processingStatus: succeeded
```

`livestream.str` is YouTube's internal name for live ingest. A separately
uploaded file carries the real uploaded filename. So no later upload step
exists, and nothing "copies" the video after the show.

### What actually differs: aspect ratio

| Show | Video | Resolution | Aspect | Size | Views |
|---|---|---|---|---|---|
| Sep 8 | `cqbI52zgl7o` | 1080×1920 | **9:16 portrait** | 761 MB | 12,229 |
| Sep 8 | `NNR4wUsprmo` | 1920×1080 | 16:9 landscape | 970 MB | 30 |
| Sep 10 | `rd2pACCHjn4` | 1080×1920 | **9:16 portrait** | 1.66 GB | 722 |
| Sep 10 | `Fd4w0vd8p08` | 1920×1080 | 16:9 landscape | 1.84 GB | 59 |

The Sep 10 portrait copy is titled with a trailing 📱. The portrait copy is the
watched one in both pairs.

### Two ingest streams, 125 ms apart

`liveBroadcasts.list(part=contentDetails)` gives each broadcast's
`boundStreamId`, and they are **different**:

```
Sep 8   cqbI52zgl7o -> ...1788887711380214     (portrait)
Sep 8   NNR4wUsprmo -> ...1788887711505959     (landscape)   +125 ms
Sep 10  rd2pACCHjn4 -> ...1789049750821157     (portrait)
Sep 10  Fd4w0vd8p08 -> ...1789049751029403     (landscape)   +208 ms
```

Both broadcasts in a pair are created in the same second
(`snippet.publishedAt` identical), with `enableAutoStart: true`, and they end at
the **identical second** (`actualEndTime` equal to the second in both pairs).
One encoder session, two RTMP destinations.

### It is StreamYard

Three of the four descriptions still carry StreamYard's auto-appended promo:

> "New to streaming or looking to level up? Check out StreamYard and get $10
> discount!" + `streamyard.com/pal/d/4997670971113472`

The fourth (`cqbI52zgl7o`) had it too — it is in the `before` snapshot our own
Phase 2 update recorded, which we then overwrote. See §3.

### When it started

38 ingest streams exist. Decoding the millisecond timestamp embedded in each
stream id and grouping by day:

```
2026-06-25 .. 2026-09-03   ONE ingest stream per show   (21 consecutive shows)
2026-09-08                 TWO
2026-09-10                 TWO
```

**A second YouTube destination was added to StreamYard between Sep 3 and Sep 8,
2026.** The StreamYard affiliate promo appears on descriptions starting the same
day, so the promo toggle was almost certainly switched on in the same session.

### What the API cannot tell us

The API never names the client that created a broadcast. The affiliate promo is
strong circumstantial evidence, not a signed attribution.

**To confirm manually, someone with the StreamYard login should check:**
Settings → Destinations. Expect **two YouTube destinations** on the JP INTEL
channel, one landscape and one vertical/portrait, plus a "promote StreamYard"
toggle that is on. Removing the destination you don't want is the fix — it is a
StreamYard setting, not anything the Studio can change.

**Nothing was deleted, unlisted, privatised or modified.** All four videos are
untouched by this investigation.

---

## 2. Canonical linkage is still a human decision

The portrait copy has more views in both pairs, and the portrait copy is the
later-created stream in one pair and the earlier in the other. Two pairs is not
a rule. Phase 3 does **not** encode `highest views = canonical` or
`portrait = canonical`; duplicates are surfaced with their view counts and the
operator confirms. A confirmed linkage is never silently replaced.

---

## 3. Standing description content — what is actually there

### YouTube: essentially nothing

Across 23 recent broadcasts, descriptions are 180–440 characters, 4–8 lines, and
are entirely episode-specific headline bullets. The **only** line recurring
across more than one description is StreamYard's affiliate promo, and only since
Sep 8.

There is no subscribe CTA, no JeffreyPrather.com link, no Locals link, no
Patreon link and no sponsor block in any current YouTube description.

> The rich description now on `cqbI52zgl7o` — sponsors, CTAs, chapters — is the
> one **we** wrote in Phase 2. It was not there before. The sponsor list in it
> came from Claude reading the transcript, not from an existing template.

### Buzzsprout: two recurring lines, and a lapsed template

Recurrence across the last 30 episodes of the public feed
(`feeds.buzzsprout.com/1762960.rss`, 522 items):

| Frequency | Line |
|---|---|
| 30/30 | `Send us Fan Mail` — injected by Buzzsprout, not authored |
| 29/30 | `Today on The Prather Point LIVE at 2 pm ET on:` + a Rumble URL |

Across all 522, a much richer template appears — and has lapsed:

| Block | Last used | Episodes ago |
|---|---|---|
| "Never get stuck in an emergency… visit our sponsors" | 2023-10-31 | 258 |
| PratherPrepSupply.com | 2023-10-31 | 258 |
| PratherDeal.com (satellite phone) | 2023-08-15 | 280 |
| Locals free news feed CTA | 2022-11-17 | 351 |

**So the premise needs correcting in one direction and confirming in another.**
The StreamYard link really did disappear because of our Phase 2 update — that
part is right, and §18's architecture is the correct fix. But there is no
existing standing-content template to preserve: it stopped being used nearly
three years ago. Studio should therefore *restore* standing content as an
operator-authored feature, not mirror something currently in production.

The recurring Rumble line in the Buzzsprout notes is also frequently stale — the
most recent episode points at a Rumble URL for a different show.

---

## 4. Buzzsprout ↔ YouTube correlation — measured, not assumed

Phase 0 recorded "Buzzsprout is already in lockstep". Measured against live
data, the relationship is tighter and stranger than "lockstep":

For 15 of the 16 most recent podcast episodes there is exactly one YouTube
broadcast satisfying both constraints:

```
YouTube broadcast aired 1-7 days BEFORE the Buzzsprout publish date
MP3 duration 3-12 s LONGER than the video duration
```

and the result is startlingly consistent:

| Signal | Value |
|---|---|
| Duration delta | **always 7–9 s, median 8 s** (MP3 longer) |
| Publish lag | **always exactly 2 or 5 days** — i.e. the next show slot |
| Title identical to YouTube | only **6 / 15** |

**The podcast runs exactly one show slot behind the stream.** A Tuesday show is
published to Buzzsprout on Thursday; a Thursday show on the following Tuesday.

**Titles are a weak key.** Nine of fifteen were rewritten for the podcast. Any
matcher that leads with title similarity will mis-link. Duration plus the
publish window is the strong key.

### Why the MP3 is ~8 seconds longer

YouTube's `actualStartTime` is consistently 7–8 s after `scheduledStartTime`
(`18:00:07`, `18:00:08`) — the ingest handshake. If the encoder began recording
locally at 18:00:00, its recording is ~8 s longer than what YouTube captured, by
exactly that margin.

**That points at the StreamYard recording, not YouTube, as the audio source** —
which matters, because it means Studio cannot derive the current MP3 from the
YouTube video. The margin is evidence, not proof; the human workflow still has
to be confirmed. See the open question in the Phase 3 report.

---

## 5. Analytics capability — and a finding that reframes the duplicate

`yt-analytics.readonly` was granted in Phase 2, so this could be measured
rather than guessed. Probed 2026-09-14 with `scripts/investigate-analytics.ts`
and `scripts/investigate-retention.ts`. Read-only.

### The Sep 8 episode is not watched by 12,229 people

Per-video report for the two copies of the same broadcast, Sep 8–14:

| | `cqbI52zgl7o` (9:16) | `NNR4wUsprmo` (16:9) |
|---|---|---|
| Views | 12,243 | 29 |
| Average view duration | **39 s** | 16 s |
| Average view percentage | **0.81 %** | 0.32 % |
| Watch time | 3,212 min | 2 min |
| Subscribers gained | 11 | 0 |

Broken down by where the views came from:

```
cqbI52zgl7o   SHORTS           9,678 views    avg  33 s
              IMMERSIVE_LIVE   2,405 views    avg  55 s
              SUBSCRIBER          77 views    avg 279 s   <-- 4.6 minutes
              everything else     83 views

NNR4wUsprmo   SUBSCRIBER          28 views    avg  19 s
              NOTIFICATION         1 view
```

Devices for the portrait copy: MOBILE 11,118 · TABLET 1,066 · DESKTOP 9 · TV 2.

**The vertical copy is being injected into swipe feeds.** 9,678 of its views
are Shorts traffic averaging 33 seconds of an 85-minute show, and a further
2,405 are the immersive live feed at 55 seconds. Those are autoplays that got
swiped past, not an audience.

The only traffic that behaves like an audience is `SUBSCRIBER`, at **279
seconds — roughly 7× longer than feed traffic**, and there were 77 of them.
Across both copies the real engaged audience for that broadcast is on the order
of **~105 views**, not 12,229.

For comparison, other channel videos average 71–94 % view percentage; those are
short clips, where finishing is easy. The full episodes sit near 1 %.

### What this changes

Phase 3 §4 already forbade `highest views = canonical`. The reason turns out to
be stronger than "two pairs is not a rule": **view count on this channel is
measuring feed distribution, not viewing.** A tactic tuned to maximise it would
be tuned to maximise swipe-throughs.

Watch time, average view percentage, and subscriber-sourced views are the
metrics that describe the actual audience.

### Available, and not

| Metric | Status |
|---|---|
| Daily channel series (views, watch time, subs gained/lost) | **Available retroactively** — 102 rows returned for Jun 1 → Sep 12 |
| Per-video engagement (views, watch time, avg duration, avg %, likes, comments, shares, subs gained) | **Available** |
| Traffic source, device, per video | **Available** |
| **Thumbnail impressions and click-through rate** | **NOT available.** `impressions` / `impressionClickThroughRate` return 400 *Unknown identifier*. Creator Studio only. |
| Ad impressions, revenue | 401 — needs Content Owner permission |
| `audienceWatchRatio`, `relativeRetentionPerformance` | 400 — query not supported on this account |

That fourth row matters for thumbnails: the natural success metric for a
thumbnail cannot be read through the API. Views arriving from
`YT_SEARCH`, `RELATED_VIDEO` and `YT_OTHER_PAGE` are a usable proxy, and
Creator Studio shows the real number to a human.

### History is recoverable for YouTube only

YouTube Analytics backfills — the daily series returned three months on request.
Nothing else does:

| Source | What it gives | Backfillable? |
|---|---|---|
| YouTube Analytics | Daily time series | **Yes** |
| Rumble Live Stream API | Current follower/subscriber totals only | **No** |
| Buzzsprout | `total_plays` per episode, point-in-time | **No** |

So for Rumble and Buzzsprout, every day without a snapshot is a day of growth
history that cannot be recovered later. That is the one part of this worth
building before the dashboard that consumes it.

### On "evaluate and adjust tactics"

At two shows a week the channel produces roughly 8–9 episodes a month. That is
far too small a sample to attribute a change in click-through or retention to a
change in title or thumbnail style; anything automated would be fitting noise
and would then propose editorial changes on the strength of it.

What the data does support is structural findings of the kind above — a 0.81 %
view percentage against a 71–94 % baseline is not a marginal effect and needs
no statistics to act on. The defensible design is: measure, attribute, surface
to a human with the sample size stated, and never let the system change
editorial direction on its own. That is the same rule as HUMAN APPROVAL, applied
to strategy instead of copy.

---

## 6. Locals and merch — capability check

Both asked for during Phase 3. Investigated rather than scoped, because in both
cases the answer changes what should be built.

### Locals: no documented API, and no feed

Probed `jeffreyprather.locals.com` on 2026-09-14:

| Path | Result |
|---|---|
| `/` | 200, SPA HTML shell |
| `/feed` | 200, **the same SPA shell** — not a feed |
| `/rss` | 200, the same SPA shell |
| `/feed.rss` | 404 |
| `/podcast` | **429** — rate limited; probing stopped |
| `/api/v1/posts` | 200 `{"errors":[],"params":[],"status":0,"code":"NOT_FOUND"}` |

Two things follow. There is **no RSS feed** — the paths that look like one
return the app shell, so anything parsing them would be parsing JavaScript.
And there is an **undocumented internal JSON API** behind `/api/v1/`, which the
error shape gives away.

Building on that internal API is the thing this project has repeatedly refused
to do. It is unversioned, undocumented, can change without notice, and would
fail silently — most likely on a show night, which is the only time it matters.
It is also the definition of the "fake automation" prohibition: an integration
that looks real until the week it isn't.

Probing stopped at the 429. Hammering a rate limiter to map an endpoint nobody
published is not research.

**Phase 0's conclusion stands, now verified rather than assumed: Locals is a
MANUAL adapter.** The Studio composes the exact post body from the approved
editorial package plus the standing blocks, marks the publication
`AWAITING_MANUAL`, and gives the operator a copy button and a "mark as posted,
paste the URL" action. That is a real, tracked pipeline step — not a green tick
for something nobody did.

The open question from Phase 0 (#12, "is there a partner API?") is still worth
one email to Locals support. It is a business question, not a technical one.

### Printful: the right API for the wrong question

Printful's API is real and well documented — bearer token, **120 calls/minute**,
with Catalog, Products, Orders, File Library, Store, Shipping, Ecommerce
Platform Sync, Webhooks and Reports.

But three facts make it the wrong integration *here*:

**1. Printful is already integrated — with WooCommerce.** The Phase 0 audit of
the live site found `WooCommerce 7.9 + Printful + PayPal`, 78 products across 19
categories. Fulfilment already works. A second Printful connection from the
Studio would be a parallel path to a system that is not broken.

**2. Printful has no sales or revenue endpoint.** Its Reports API exposes
statistics, not money. Revenue lives in WooCommerce, which is the storefront and
the system of record. Asking Printful "how is merch doing" asks the fulfiller,
not the till.

**3. The product catalogue is already public.** `jeffreyprather.com` serves the
WooCommerce Store API unauthenticated:

```
GET /wp-json/wc/store/v1/products    200, full product JSON
GET /wp-json/wp/v2/product           200, full product JSON
```

Names, permalinks, descriptions, images and prices, with **no credential
required**. So putting a merch link in an episode description needs no new
integration at all — and a standing block in Settings already covers it at zero
integration cost, because merch links change rarely and a promo code typed once
is safer than one synced every night.

**Recommendation.** Do not connect Printful to the Episode Desk. If the goal is
merch *revenue* alongside channel growth, the source is WooCommerce's
authenticated reports endpoint (`/wp-json/wc/v3/reports/sales`), which needs a
consumer key and belongs with the Phase 4 metrics work. If the goal is merch
*promotion*, the standing-block model built in Phase 3 already does it.

---

## 7. The audio source — where the MP3 actually comes from

Phase 3 §26 asked this before any audio architecture was designed, which was
the right order: the answer rules out the obvious approach.

### The evidence

**The MP3 is 7–9 s longer than the YouTube video, every time** (§4, median 8 s
across 15 episodes). That margin is not arbitrary. YouTube's
`actualStartTime` is consistently 7–8 s after its `scheduledStartTime` —
`18:00:07`, `18:00:08` against an `18:00:00` slot — which is the RTMP ingest
handshake. So the recording that became the MP3 **started roughly 8 seconds
before YouTube began capturing**, and the only thing running at that moment is
the encoder.

The encoder is StreamYard, established independently in §1 by the affiliate
promo and the twin ingest streams.

**Conclusion: the MP3 is produced from the StreamYard recording, not from
YouTube.** If it were derived from the YouTube video the durations would match
exactly rather than differ by a constant.

### Why the Studio cannot automate it today

| Route | Status |
|---|---|
| StreamYard recording | **No public API at all.** Confirmed in Phase 0 and unchanged; its Zapier app covers webinar registrants only. |
| Rumble recording | No VOD listing and no media retrieval — Phase 0, unchanged. |
| YouTube media | The Data API returns metadata and captions. There is no endpoint that returns the media, and extracting it another way is against YouTube's terms. |
| Re-fetching the published MP3 | `audio.buzzsprout.com` sits behind **Cloudflare, which returns 403 to a scripted client**. Verified by request. Working around that would be bot-detection evasion and is not something this project will do. |

So there is no supported path from any connected provider to an audio file.

### What this means for Phase 3

Buzzsprout's API *does* accept an `audio_url` that it fetches, so the write side
is solved the moment a file exists somewhere reachable. What is missing is the
file.

Per §30, the correct outcome is therefore **`BUZZSPROUT READY — AUDIO
REQUIRED`**: approved metadata is prepared, the linkage is real, and the Studio
states plainly that a human still has to supply the audio. It does not
fabricate an `audio_url`, and `createEpisode` refuses to run without one.

Truthful partial automation, which is what was asked for.

### The open question for Jeff — a human workflow question, not a technical one

The remaining unknown is what actually happens today between StreamYard and
Buzzsprout:

1. Is the recording downloaded from StreamYard by hand after each show?
2. Does it land anywhere with a stable URL — Drive, Dropbox, object storage?
3. Is it converted to MP3 first, and by what?
4. Who uploads it to Buzzsprout, and through the web UI or otherwise?

If the file already passes through somewhere with a reachable URL, the Studio
can take it from there and the remaining manual step collapses to one paste.
If it goes StreamYard → laptop → browser upload, then automating it needs
somewhere to put the file, which is a storage decision rather than an
integration one.
