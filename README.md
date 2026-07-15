# Serendipity Events

The agentic event database behind [Serendipity](https://github.com/Serendipity-HQ) — a pipeline that continuously pulls events happening in our markets, normalizes them into one canonical schema, enriches them with Claude, and keeps the data fresh.

## How it works

```
Ticketmaster Discovery API ─┐
(future: SeatGeek, Meetup…) ─┤→ normalize → SQLite upsert → Claude enrichment → data/events.json
                             │   (dedupe by source+id)      (category, vibes,
GitHub Actions cron (3h) ────┘                               feed blurb)
```

1. **Ingest** — `src/sources/ticketmaster.ts` pages through the [Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/) for every market in `config/markets.json` (rate-limit aware, 90-day lookahead).
2. **Store** — events upsert into `data/events.db` keyed by `(source, source_id)`. Re-ingesting refreshes facts (price, status, date) without touching enrichment. Future events that vanish from the source feed get flagged `unverified`; cancellations from the source are recorded as `cancelled`.
3. **Enrich (the agentic part)** — new events are batched to Claude, which maps messy source taxonomies onto Serendipity's canonical categories, tags social "vibes" (`date-night`, `family-friendly`, …), and writes a one-line blurb for the feed. Enrichment is idempotent and best-effort: anything that fails is retried on the next run.
4. **Publish** — upcoming events are exported to `data/events.json` (stable ordering, diffable). The app can consume this directly via `raw.githubusercontent.com` until we stand up a real API.
5. **Repeat** — `.github/workflows/ingest.yml` runs the whole thing weekly (Mondays 08:17 UTC — tighten the cron when needed) and commits the refreshed data back to the repo. No servers to run.

## Setup

1. **Get a Ticketmaster API key** (free): <https://developer.ticketmaster.com/> → create an app → copy the Consumer Key.
2. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `TICKETMASTER_API_KEY` — required
   - `ANTHROPIC_API_KEY` — optional; enables enrichment
3. **Pick your markets** — edit `config/markets.json` (name, `lat,long`, radius in miles). Defaults to San Francisco.
4. Trigger the **Ingest events** workflow manually (Actions tab → Run workflow) or wait for the next cron tick.

### Run locally

```bash
npm install
cp .env.example .env   # fill in keys
set -a; source .env; set +a
npm run ingest
```

## Canonical event schema

Every source normalizes into `CanonicalEvent` (`src/types.ts`): identity (`source`, `source_id`), when (`starts_at`, `local_date`, `timezone`), where (venue, city, lat/long), what (title, segment/genre from the source, image, price range, status), plus enrichment (`category`, `vibes[]`, `blurb`).

Canonical categories: `music`, `sports`, `arts-theatre`, `comedy`, `film`, `food-drink`, `nightlife`, `family`, `community`, `other`.

## Adding a new source

Implement the `EventSource` interface in `src/sources/<name>.ts` (one method: `fetchEvents(market)` returning `CanonicalEvent[]`) and register it in `src/ingest.ts`. Storage, dedupe, staleness tracking, and enrichment all come for free. Candidates: SeatGeek, Bandsintown, Meetup, SerpApi Google Events.

## Roadmap

- [ ] SeatGeek source (free key; overlaps TM but catches secondary listings)
- [ ] Cross-source dedupe (fuzzy title + same venue + same start time)
- [ ] Graduate SQLite → Postgres (Supabase/Neon) when the app needs live queries
- [ ] Serve events via an API instead of the committed JSON snapshot
