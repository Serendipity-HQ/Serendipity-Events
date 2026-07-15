import fs from "node:fs";
import { openDb, upsertEvent, markStale, getUnenriched, saveEnrichment, exportJson } from "./db.js";
import { enrichEvents } from "./enrich.js";
import { ticketmasterSource } from "./sources/ticketmaster.js";
import type { EventSource, Market } from "./types.js";

const DB_PATH = process.env.DB_PATH ?? "data/events.db";
const JSON_PATH = process.env.JSON_PATH ?? "data/events.json";
const MARKETS_PATH = process.env.MARKETS_PATH ?? "config/markets.json";
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT ?? 200);

async function main() {
  const tmKey = process.env.TICKETMASTER_API_KEY;
  if (!tmKey) {
    console.error(
      "TICKETMASTER_API_KEY is not set. Get a free key at https://developer.ticketmaster.com/",
    );
    process.exit(1);
  }

  const markets = JSON.parse(fs.readFileSync(MARKETS_PATH, "utf8")) as Market[];
  const sources: EventSource[] = [
    ticketmasterSource(tmKey),
    // Future sources plug in here: seatgeekSource(), bandsintownSource(), ...
  ];

  const db = openDb(DB_PATH);
  const runStartedAt = new Date().toISOString();
  console.log(`ingest: run started ${runStartedAt} — ${markets.length} market(s), ${sources.length} source(s)`);

  for (const source of sources) {
    for (const market of markets) {
      try {
        const events = await source.fetchEvents(market);
        const insert = db.transaction(() => {
          for (const ev of events) upsertEvent(db, ev, runStartedAt);
        });
        insert();
        const stale = markStale(db, market.name, runStartedAt);
        console.log(
          `ingest: ${source.name} / ${market.name} — ${events.length} events upserted, ${stale} flagged unverified`,
        );
      } catch (err) {
        // One bad market/source shouldn't kill the whole run.
        console.error(`ingest: ${source.name} / ${market.name} failed: ${err}`);
        process.exitCode = 1;
      }
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const pending = getUnenriched(db, ENRICH_LIMIT);
    if (pending.length > 0) {
      console.log(`enrich: ${pending.length} new event(s) to classify`);
      const { enriched, errors } = await enrichEvents(pending);
      const save = db.transaction(() => {
        for (const [id, e] of enriched) saveEnrichment(db, id, e);
      });
      save();
      console.log(`enrich: ${enriched.size} enriched, ${errors} deferred to next run`);
    }
  } else {
    console.log("enrich: ANTHROPIC_API_KEY not set — skipping enrichment");
  }

  const exported = exportJson(db, JSON_PATH, runStartedAt);
  console.log(`export: ${exported} upcoming events written to ${JSON_PATH}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
