import type { CanonicalEvent, EventSource, EventStatus, Market } from "../types.js";

const BASE_URL = "https://app.ticketmaster.com/discovery/v2/events.json";
const PAGE_SIZE = 200;
// Discovery API rejects requests where (page + 1) * size > 1000 (deep paging cap).
const MAX_ITEMS = 1000;
// Free tier allows 5 req/s; stay comfortably under it.
const REQUEST_DELAY_MS = 300;
const LOOKAHEAD_DAYS = 90;

interface TMPage {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

interface TMEvent {
  id: string;
  name: string;
  url?: string;
  dates?: {
    start?: { dateTime?: string; localDate?: string };
    timezone?: string;
    status?: { code?: string };
  };
  classifications?: Array<{
    segment?: { name?: string };
    genre?: { name?: string };
  }>;
  priceRanges?: Array<{ min?: number; max?: number; currency?: string }>;
  images?: Array<{ url: string; width?: number; ratio?: string }>;
  _embedded?: {
    venues?: Array<{
      name?: string;
      city?: { name?: string };
      state?: { stateCode?: string; name?: string };
      location?: { latitude?: string; longitude?: string };
    }>;
  };
}

interface TMResponse {
  _embedded?: { events?: TMEvent[] };
  page: TMPage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discovery API wants YYYY-MM-DDTHH:mm:ssZ with no milliseconds. */
function tmTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mapStatus(code: string | undefined): EventStatus {
  switch (code) {
    case "onsale":
      return "onsale";
    case "offsale":
      return "offsale";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "postponed":
      return "postponed";
    case "rescheduled":
      return "rescheduled";
    default:
      return "unknown";
  }
}

function pickImage(images: TMEvent["images"]): string | null {
  if (!images?.length) return null;
  const widescreen = images
    .filter((i) => i.ratio === "16_9")
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return (widescreen[0] ?? images[0]).url;
}

function normalize(ev: TMEvent, market: Market): CanonicalEvent {
  const venue = ev._embedded?.venues?.[0];
  const classification = ev.classifications?.[0];
  const price = ev.priceRanges?.[0];
  const lat = venue?.location?.latitude;
  const lon = venue?.location?.longitude;
  return {
    id: `ticketmaster:${ev.id}`,
    source: "ticketmaster",
    source_id: ev.id,
    title: ev.name,
    url: ev.url ?? null,
    starts_at: ev.dates?.start?.dateTime ?? null,
    local_date: ev.dates?.start?.localDate ?? null,
    timezone: ev.dates?.timezone ?? null,
    venue_name: venue?.name ?? null,
    city: venue?.city?.name ?? null,
    region: venue?.state?.stateCode ?? venue?.state?.name ?? null,
    latitude: lat != null ? Number(lat) : null,
    longitude: lon != null ? Number(lon) : null,
    segment: classification?.segment?.name ?? null,
    genre: classification?.genre?.name ?? null,
    price_min: price?.min ?? null,
    price_max: price?.max ?? null,
    currency: price?.currency ?? null,
    image_url: pickImage(ev.images),
    status: mapStatus(ev.dates?.status?.code),
    market: market.name,
  };
}

export function ticketmasterSource(apiKey: string): EventSource {
  return {
    name: "ticketmaster",

    async fetchEvents(market: Market): Promise<CanonicalEvent[]> {
      const now = new Date();
      const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
      const events: CanonicalEvent[] = [];
      let page = 0;

      while (true) {
        const params = new URLSearchParams({
          apikey: apiKey,
          latlong: market.latlong,
          radius: String(market.radiusMiles),
          unit: "miles",
          size: String(PAGE_SIZE),
          page: String(page),
          sort: "date,asc",
          startDateTime: tmTimestamp(now),
          endDateTime: tmTimestamp(end),
        });

        const res = await fetch(`${BASE_URL}?${params}`);
        if (res.status === 429) {
          await sleep(2000);
          continue; // retry the same page after backing off
        }
        if (!res.ok) {
          throw new Error(
            `Ticketmaster ${res.status} for ${market.name} page ${page}: ${await res.text()}`,
          );
        }

        const body = (await res.json()) as TMResponse;
        for (const ev of body._embedded?.events ?? []) {
          events.push(normalize(ev, market));
        }

        const { number, totalPages } = body.page;
        const nextPageStart = (number + 1) * PAGE_SIZE;
        if (number + 1 >= totalPages || nextPageStart >= MAX_ITEMS) break;

        page = number + 1;
        await sleep(REQUEST_DELAY_MS);
      }

      return events;
    },
  };
}
