// Picks where control-plane state lives.
//
//   CODERVIBES_STORE=json     (default) two JSON files next to the app
//   CODERVIBES_STORE=dynamo   DynamoDB, for anything deployed
//
// Only persistence is swapped. The registry keeps its in-memory model and its
// synchronous read API either way, so nothing above this layer changes.
//
// The backend that is not chosen is not loaded. DynamoDB's client is three
// AWS SDK packages and the Fly credential dance behind them, and an
// installation keeping its state in two JSON files next to the app has no
// use for any of it - the top-level await below is what keeps it off the
// disk. The chosen one is built before this module finishes, so `store` is
// the same object it always was to everything that imports it.
import { JsonStore } from "./json-store.js";

const BACKENDS = {
  json: async () => new JsonStore(),
  dynamo: async () => new (await import("./dynamo-store.js")).DynamoStore(),
};

const requested = process.env.CODERVIBES_STORE ?? "json";
const build = BACKENDS[requested];

if (!build) {
  throw new Error(
    `Unknown CODERVIBES_STORE '${requested}'. Expected one of: ${Object.keys(BACKENDS).join(", ")}`,
  );
}

export const store = await build();
