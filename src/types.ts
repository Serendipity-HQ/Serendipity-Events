/**
 * The canonical event shape every source normalizes into.
 * `id` is `${source}:${source_id}` so the same event from two sources
 * never collides, and re-ingesting the same event upserts in place.
 */
export interface CanonicalEvent {
  id: string;
  source: string;
  source_id: string;
  title: string;
  url: string | null;
  starts_at: string | null; // ISO 8601 UTC
  local_date: string | null; // YYYY-MM-DD in the venue's timezone
  timezone: string | null;
  venue_name: string | null;
  city: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  segment: string | null; // source-provided taxonomy (e.g. "Music")
  genre: string | null; // source-provided sub-taxonomy (e.g. "Indie Rock")
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  image_url: string | null;
  status: EventStatus;
  market: string;
}

export type EventStatus =
  | "onsale"
  | "offsale"
  | "cancelled"
  | "postponed"
  | "rescheduled"
  | "unverified" // stopped appearing in source refreshes before its date
  | "unknown";

/** Fields produced by the agentic enrichment layer. */
export interface Enrichment {
  category: string;
  vibes: string[];
  blurb: string;
}

/** A geographic area to ingest events for. */
export interface Market {
  name: string;
  latlong: string; // "lat,long"
  radiusMiles: number;
  /** Optional exact venue-city filter (e.g. "San Francisco"), narrower than the radius. */
  city?: string;
  stateCode?: string;
}

/**
 * Every event source implements this. Adding SeatGeek, Bandsintown, etc.
 * later means writing one file in src/sources/ and registering it in
 * src/ingest.ts — the pipeline handles storage, dedupe, and enrichment.
 */
export interface EventSource {
  name: string;
  fetchEvents(market: Market): Promise<CanonicalEvent[]>;
}
