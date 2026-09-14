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
