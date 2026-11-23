# SOUNDINGS — design spec (from the "Visual Direction" board)

Source of truth: the single visual-direction board (1536×1024). No live reference site was provided, so every value below is measured or sampled from that board.

## Concept
Daily trivia with typed answers and rarity scoring — see "Gameplay" below.

## Color tokens (sampled from the board palette)
| Token | Hex | Use |
|---|---|---|
| `--abyss` | #071522 | page / deepest water |
| `--navy` | #0D2233 | panel fill |
| `--ocean` | #16445A | mid water, empty progress border |
| `--bio` | #54D6D0 | accent, borders, glow, filled progress |
| `--foam` | #D8E9E7 | primary text |
| `--gold` | #E8B84A | score pill border/star |
| `--warn` | #FF7A6B | timer ≤10s, wrong answer (crab red family) |

## Typography
- Wordmark: blocky retro pixel caps → **Silkscreen 700**, vertical gradient #E6FBF9 → #54D6D0, faint scanlines, dark 2px drop + cyan glow.
- UI caps (panel tabs, question, buttons, timer): **Rajdhani 600/700**, uppercase, 0.06–0.12em tracking.
- Captions ("DARK, ATMOSPHERIC…"): Rajdhani 500, 12px, 0.28em tracking, foam @ 70%.
- Sentence text ("Daily Trivia. Deep Rewards."): **Inter 600**.

## Shapes
- Panels: 1px `--bio` @ 35% border, radius 12px, navy→abyss translucent fill, attached top-left tab label (radius 10px top corners).
- Question card: 1.5px `--bio` @ 70%, radius 12px, centered caps text.
- Progress: 7 pill segments, 10px tall; filled = `--bio` + glow, empty = dark + ocean border; counter "3 / 7" right.
- Timer: line clock icon + `00:45`, cyan glow.
- Submit: 2px `--bio` outline, radius 10px, outer + inner glow, caps.
- Score pill: gold outline, gold star, comma-formatted number.

## Graphics
- Background: low-res canvas (4 css px per pixel) scene — banded water gradient, animated surface ripples, swaying light rays, far + near rock cliffs, kraken silhouette with glowing eyes, coral/seaweed seabed, glowing fish, pixel bubbles, marine snow.
- Creatures: hand-authored pixel maps (fish, clownfish, blue tang, pink wrasse, anglerfish, jelly, seahorse, crab, sea star, coral, manta, krill), nearest-neighbor scaled with soft cyan glow.

## Motion
- Screen change: 320ms fade + 12px rise. Progress fill 400ms. Score count-up 700ms.
- Correct: bubble burst. Wrong: 300ms panel shake. Timer ≤10s: pulse.
- `prefers-reduced-motion`: static scene frame, no transitions.

## Gameplay (implemented)
- **Daily dive**: 7 open-ended questions ("Name a …"), same set and order for every player, chosen deterministically from the bank and frozen in the DB per day. Resets 00:00 UTC. Dive #1 = 2026-01-01.
- **Answering**: typed. Case, spaces, accents, punctuation, leading articles, plurals and question words (e.g. "ocean") are normalised; aliases per answer; typos allowed (1 edit for 5–8 letters, 2 for 9+, none for ≤4); ambiguous typos rejected. Wrong answers can be retried until time runs out; repeats are ignored. Pass = 0.
- **Timer**: 25 s per question, deadline stored server-side; refresh never resets it; 750 ms network grace.
- **Rarity tiers** (share of accepted answers): Drifter 10 (≥20%) · Scuttler 20 (≥10%) · Glimmer 35 (≥5%) · Lantern 55 (≥2%) · Leviathan 80 (≥0.5%) · Fallen Star 100 (<0.5%). Max 700.
- **Rarity data**: every answer has a *development seed estimate* (weights in `server/questions.js`, worth 200 virtual players). Real accepted answers are counted in `answer_counts` and outweigh the seed as players accumulate. The results screen says how many real answers are on record.
- **Depth**: 1 point = 10 m. Zones: Sunlight <200 m, Twilight <1,000, Midnight <4,000, Abyssal <6,000, Hadal. The scene darkens, light rays and surface fade, and bioluminescence appears as depth grows.

## Architecture
| Path | Role |
|---|---|
| `server/questions.js` | question bank, accepted answers, aliases, seed frequencies |
| `server/engine.js` | pure logic: normalise/match, rarity → tier → points, depth, daily selection |
| `server/db.js` | SQLite schema (`node:sqlite`): players, daily, sessions, rounds (timer + result), attempts, answer_counts |
| `server/game.js` | session service: start/answer/pass/next, seq-based replay protection, lazy timeout settlement, stats |
| `server/server.js` | HTTP: JSON API + static `public/`; anonymous `sid` cookie (HttpOnly, SameSite=Strict); JSON-only + same-origin POSTs |
| `public/index.html` | UI + pixel scene; displays server state only, never scores |

API: `GET /api/state`, `POST /api/start`, `POST /api/answer {seq,text}`, `POST /api/pass {seq}`, `POST /api/next {seq}`.

## Run / test
```
npm start                # http://localhost:8765  (DB at data/soundings.db)
npm run test:unit        # engine + game service (node:test)
npm run test:e2e         # Playwright, full dive desktop + mobile, ~60 s; screenshots in test-results/
node scripts/fetch-ngram.js   # resumable Google Books Ngram fetch into data/ngram-cache.json
npm run build:freq -- <large_en.msgpack.gz> --ngram data/ngram-cache.json   # rebuild server/bank/_freq.json
```

### Print-frequency prior (on, gently)
Krillion scores rarity by how often a name appears in print. `server/bank/_freq.json` holds a Zipf score for every answer. It comes from two sources:
- Google Books Ngram (whole names, case-sensitive) for the 124 questions fetched before Google started returning 403;
- wordfreq for the rest.

`applyPrintFrequency` in `server/engine.js` mixes it into the starting weights. Live player counts then take over as before.

Print alone misfires on context: "France" for Brazil's borders, "Pawn" for chess pieces, "Monster" for soft drinks. Fully on, it made 8,300 of 19,100 answers Fallen Star. So:
- print is scaled to the question's median answer;
- an answer whose print rating is more than 5× (`FREQ_TRUST`) off the question's own order counts as a misfire and is ignored;
- the rest blend 50/50 (`FREQ_BLEND`) and move at most 3× (`FREQ_CLAMP`).

Result: about 22% of answers move one tier, 9 move two, and about a third are ignored as misfires. Set `FREQ_BLEND = 0` to switch it off.

Frequency data: Google Books Ngram Viewer; wordfreq by Robyn Speer (doi.org/10.5281/zenodo.7199437), data CC BY-SA 4.0.
Players are anonymous (cookie). Clearing cookies or switching browsers = a new player; one-attempt-per-day holds per cookie, not per person (needs accounts to go further).

## Production-readiness upgrade
- **Frozen daily rarity**: when a day is first served, each of its questions' `answer_counts` are copied to `rarity_snapshot`; all scoring and "most common answers" that day read the snapshot. Same answer = same tier for every player all day. Today's answers only move future days.
- **Question bank**: 56 questions in 14 categories (`server/questions.js` + `server/questions-more.js`). Schedule: seeded 8-day cycles, every question once per cycle, max 2 per category per dive.
- **Zones**: Sunlight (rays, ripples) → Twilight (blue tint, lanternfish shoal) → Midnight (glowing jellies, bioluminescence) → Abyssal (anglerfish with lure, heavy marine snow) → Hadal (trench walls close in, amphipods, pressure pulse). Crossing a zone shows a banner + a dark sweep with rushing bubbles.
- **Rare rewards**: Lantern = lure flash; Leviathan = manta glides across the scene, blue glow; Fallen Star = a star falls into the answer card and bursts into sparks, gold screen flash, score pop.
- **Identity**: cookie = random token, DB stores SHA-256 only (`auth_tokens`); old cookies migrate automatically. `accounts` + `identities` tables and `auth.linkIdentity / playerForIdentity` are ready for OAuth/email login (no login UI yet). Players are created only on Start.
- **Logbook**: dives, total, average, best, deepest, current + longest streak, answer rate, passes/timeouts, per-tier counts, last 14 dives.
- **Security**: CSP, X-Frame-Options DENY, nosniff, no-referrer, Permissions-Policy, COOP; per-IP rate limits (writes 40/10 s, reads 120/10 s, new players 20/h); request/header timeouts; `TRUST_PROXY=1` for X-Forwarded-For behind a proxy.
- **Daily reset**: an unfinished dive from an earlier day is closed at 00:00 UTC (open question → timeout); stale requests get 409 and the client returns to the title.
- **Timer**: client clock anchored to `performance.now()` at the request midpoint (RTT/2), so device clock changes can't skew the display; the server deadline remains authoritative.

## Descent scene (`public/descent.js`)
- **Pip**, an original pixel explorer (brass helmet, cyan visor, orange suit, 4-frame fin kick, headlamp), drawn at 2×. Idle: horizontal, bobbing, breathing bubbles. Diving: rotates head-down, fins kick 3× faster, bubble trail.
- **World in metres**: 100 m ≈ a third of the screen. Pip's depth always equals `score × 10`; it is set with `place(m)` (load/resume/refresh, no animation) or `descend(m, tier)` (after a scored answer). Never reset between questions.
- **Camera**: spring-follows Pip (trails while diving, settles when idle). Parallax: far cliffs 0.35×, mid rocks 0.7×, creatures 1×, foreground kelp/coral/sea pens 1.4×; snow, plankton and bubbles are world-anchored, so they stream up past a diving Pip (snow streaks with camera speed).
- **Zones**: Sunlight (sky, surface, rays, reef fish, kelp, coral) → Twilight (rays fade, lanternfish, jellies, manta) → Midnight (no sunlight, glowing jellies, siphonophores, the kraken at 2,350 m) → Abyssal (anglerfish, hydrothermal vents) → Hadal (trench walls close in, amphipods, snailfish, trench floor at 7,150 m). Darkness grows with depth; Pip's headlamp keeps a lit pool.
- **Flow**: answer accepted → reward reveal (0.7–1.6 s by tier) → panel steps aside, HUD counts metres → descent (1.6–4.2 s by tier + distance) → panel returns. Next during the reveal/descent speeds it up (still animated).
- **Tier effects**: Drifter gentle trail · Scuttler/Glimmer more bubbles + glow · Lantern an anglerfish escort lights the way · Leviathan a giant manta escort + camera rumble · Fallen Star a guiding star, gold/violet spiral, camera shake, arrival flash ring.
- **Title screen** keeps the classic scene; play/results/logbook crossfade into the descent scene.
- **Reduced motion**: no descent animation; Pip is placed at the new depth.

## Unlimited dives (replaces the daily game)
- **No daily limits.** Every game is a dive with its own id (`d_…`), stored in `dives` / `dive_rounds` / `dive_attempts`. Starting a new dive closes an unfinished one as `abandoned` (kept out of stats). Old daily results migrate into the history as "Daily Dive (legacy)".
- **Modes** (`server/topics.js`, timers configurable there): Quick Dive (7 from one topic, 25 s) · Topic Special (7 from one topic, easy → hard, 30 s, mastery rank) · Mixed Dive (7 from 7 different topics, 25 s) · Endless Dive (topic optional, 20 s, 3 air tanks; a pass or timeout costs one; Surface any time keeps the score; ends when out of air).
- **Topics**: 20 in 4 groups, each with colour, description and 9×9 pixel icon. Add one by adding an entry to `TOPICS` and ≥ 7 questions with that `topic`.
- **Questions**: 184 curated open-ended questions (`server/questions.js`, `q-general.js`, `q-nature.js`, `q-entertainment.js`, `q-culture.js`), each with accepted answers, aliases, topic, difficulty, hint and explanation. No repeats inside a dive; the picker serves questions the player hasn't seen in their last 150 before repeating any.
- **Rarity**: unchanged tiers. Unweighted answers get a graded seed estimate from their list position (lists run most-common first) instead of all counting as ultra-rare. Live answer counts are snapshotted per question per UTC day so everyone is scored alike.
- **Depth**: Endless can go past 7,000 m; the trench floor sits at 11,000 m and Pip stops just above it (the counter shows true depth).
- **API**: `GET /api/state`, `POST /api/dive {mode, topic}`, `POST /api/answer|pass|next|surface {dive, seq, …}`, `GET /api/dives`, `GET /api/dives/:id` (own dives only).
- **Stats** (Logbook): dives completed, questions answered, best dive, deepest, 7-question average, answer rate, total points, rarities collected, rarest answer, favourite topics, records per mode (incl. longest Endless run), last 14 dives, and a reviewable list of every past dive.
