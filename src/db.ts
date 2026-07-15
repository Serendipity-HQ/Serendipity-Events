import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { CanonicalEvent, Enrichment } from "./types.js";

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT,
      starts_at   TEXT,
      local_date  TEXT,
      timezone    TEXT,
      venue_name  TEXT,
      city        TEXT,
      region      TEXT,
      latitude    REAL,
      longitude   REAL,
      segment     TEXT,
      genre       TEXT,
      price_min   REAL,
      price_max   REAL,
      currency    TEXT,
      image_url   TEXT,
      status      TEXT NOT NULL DEFAULT 'unknown',
      market      TEXT NOT NULL,
      -- agentic enrichment (preserved across refreshes)
      category    TEXT,
      vibes       TEXT, -- JSON array
      blurb       TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      UNIQUE (source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events (starts_at);
    CREATE INDEX IF NOT EXISTS idx_events_market ON events (market);
    CREATE INDEX IF NOT EXISTS idx_events_category ON events (category);
  `);
  return db;
}

/** Insert or refresh an event. Enrichment columns are never clobbered. */
export function upsertEvent(db: Db, ev: CanonicalEvent, seenAt: string): void {
  db.prepare(
    `INSERT INTO events (
       id, source, source_id, title, url, starts_at, local_date, timezone,
       venue_name, city, region, latitude, longitude, segment, genre,
       price_min, price_max, currency, image_url, status, market,
       first_seen_at, last_seen_at
     ) VALUES (
       @id, @source, @source_id, @title, @url, @starts_at, @local_date, @timezone,
       @venue_name, @city, @region, @latitude, @longitude, @segment, @genre,
       @price_min, @price_max, @currency, @image_url, @status, @market,
       @seenAt, @seenAt
     )
     ON CONFLICT (source, source_id) DO UPDATE SET
       title = excluded.title,
       url = excluded.url,
       starts_at = excluded.starts_at,
       local_date = excluded.local_date,
       timezone = excluded.timezone,
       venue_name = excluded.venue_name,
       city = excluded.city,
       region = excluded.region,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       segment = excluded.segment,
       genre = excluded.genre,
       price_min = excluded.price_min,
       price_max = excluded.price_max,
       currency = excluded.currency,
       image_url = excluded.image_url,
       status = excluded.status,
       market = excluded.market,
       last_seen_at = excluded.last_seen_at`,
  ).run({ ...ev, seenAt });
}

/**
 * Future events in this market that stopped appearing in the source feed
 * are flagged 'unverified' — possibly cancelled or moved; worth re-checking
 * before surfacing prominently in the app.
 */
export function markStale(db: Db, market: string, runStartedAt: string): number {
  const result = db
    .prepare(
      `UPDATE events
       SET status = 'unverified'
       WHERE market = ?
         AND last_seen_at < ?
         AND starts_at > ?
         AND status IN ('onsale', 'offsale', 'unknown')`,
    )
    .run(market, runStartedAt, runStartedAt);
  return result.changes;
}

export interface UnenrichedEvent {
  id: string;
  title: string;
  segment: string | null;
  genre: string | null;
  venue_name: string | null;
  city: string | null;
  local_date: string | null;
  price_min: number | null;
}

export function getUnenriched(db: Db, limit: number): UnenrichedEvent[] {
  return db
    .prepare(
      `SELECT id, title, segment, genre, venue_name, city, local_date, price_min
       FROM events
       WHERE category IS NULL AND status NOT IN ('cancelled')
       ORDER BY starts_at ASC
       LIMIT ?`,
    )
    .all(limit) as UnenrichedEvent[];
}

export function saveEnrichment(db: Db, id: string, e: Enrichment): void {
  db.prepare(
    `UPDATE events SET category = ?, vibes = ?, blurb = ? WHERE id = ?`,
  ).run(e.category, JSON.stringify(e.vibes), e.blurb, id);
}

/**
 * Export upcoming events as JSON, sorted for stable diffs. The Serendipity
 * frontend can consume this directly (e.g. via raw.githubusercontent.com)
 * until there's a real API in front of the database.
 */
export function exportJson(db: Db, outPath: string, asOf: string): number {
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE starts_at >= ? AND status NOT IN ('cancelled')
       ORDER BY starts_at ASC, id ASC`,
    )
    .all(asOf) as Array<Record<string, unknown>>;

  const events = rows.map((r) => ({
    ...r,
    vibes: typeof r.vibes === "string" ? JSON.parse(r.vibes) : null,
  }));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: asOf, count: events.length, events }, null, 1) + "\n",
  );
  return events.length;
}
