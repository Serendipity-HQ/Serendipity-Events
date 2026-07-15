import Anthropic from "@anthropic-ai/sdk";
import type { Enrichment } from "./types.js";
import type { UnenrichedEvent } from "./db.js";

/**
 * The agentic layer: Claude classifies each event into Serendipity's canonical
 * taxonomy, tags it with social "vibes", and writes a feed-ready blurb —
 * the judgment calls that rule-based mapping from source taxonomies does badly.
 */

export const CATEGORIES = [
  "music",
  "sports",
  "arts-theatre",
  "comedy",
  "film",
  "food-drink",
  "nightlife",
  "family",
  "community",
  "other",
] as const;

const BATCH_SIZE = 25;
const MODEL = "claude-opus-4-8";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          vibes: { type: "array", items: { type: "string" } },
          blurb: { type: "string" },
        },
        required: ["id", "category", "vibes", "blurb"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You enrich event listings for Serendipity, a social app that connects people to events happening around them and lets them post about it.

For each event you receive, return:
- "id": echoed back unchanged.
- "category": the single best fit from the allowed list. Use the source's segment/genre as a hint, but override it when the title clearly says otherwise (e.g. a comedy show listed under "Music").
- "vibes": 1-3 short lowercase tags describing who the event is for or what going feels like, e.g. "date-night", "family-friendly", "big-crowd", "chill", "late-night", "outdoorsy", "splurge", "budget-friendly".
- "blurb": one punchy sentence (max 140 characters) selling the event for a social feed. No emoji, no hashtags, no "don't miss".`;

interface EnrichmentResult {
  enriched: Map<string, Enrichment>;
  errors: number;
}

export async function enrichEvents(
  events: UnenrichedEvent[],
): Promise<EnrichmentResult> {
  const client = new Anthropic();
  const enriched = new Map<string, Enrichment>();
  let errors = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: {
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              batch.map((e) => ({
                id: e.id,
                title: e.title,
                segment: e.segment,
                genre: e.genre,
                venue: e.venue_name,
                city: e.city,
                date: e.local_date,
                price_from: e.price_min,
              })),
            ),
          },
        ],
      });

      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      )?.text;
      if (!text) throw new Error("no text block in response");

      const parsed = JSON.parse(text) as { events: Array<Enrichment & { id: string }> };
      const validIds = new Set(batch.map((e) => e.id));
      for (const item of parsed.events) {
        if (!validIds.has(item.id)) continue;
        enriched.set(item.id, {
          category: item.category,
          vibes: item.vibes.slice(0, 3),
          blurb: item.blurb.slice(0, 200),
        });
      }
    } catch (err) {
      // Enrichment is best-effort: unenriched events are retried next run.
      errors += batch.length;
      console.error(
        `enrich: batch ${i / BATCH_SIZE + 1} failed (${batch.length} events): ${err}`,
      );
    }
  }

  return { enriched, errors };
}
