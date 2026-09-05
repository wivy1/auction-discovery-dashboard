import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type AuctionDb = ReturnType<typeof createDb>;

export function getDb(binding?: D1Database): AuctionDb {
  const database = binding ?? env.DB;
  if (!database) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return createDb(database);
}
