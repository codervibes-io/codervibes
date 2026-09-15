// Where a machine is, worked out from what it says and what the platforms
// say.
//
// The setup script runs on a laptop, in an e2b sandbox, in a Niteshift
// environment, in a container somebody built - and a person should not have
// to say which. So the script reports the marks a platform leaves on its
// machines (e2b sets E2B_SANDBOX_ID, Niteshift sets NITESHIFT_LIFECYCLE_*,
// Codespaces sets CODESPACES, and so on), and this turns those into a
// platform. Where the marks say nothing and the person has connected e2b,
// the platform itself is asked: e2b lists the sandboxes their key can see,
// and a machine whose name is one of them is an e2b sandbox whatever its
// environment said. That is the one thing a key can tell us that the
// machine cannot, and it is the reason to ask.
//
// The answer is one word for the session's `host` (telemetry-ingest.js
// `whereOf`), which is what the Executors page shows as the location.

/** The environment variable each platform sets on its machines, and the word for it here. */
export const MARKERS = Object.freeze({
  // Niteshift before e2b, and not alphabetically: a Niteshift environment
  // runs on somebody else's sandboxes - e2b's today - so it sets both, and
  // "e2b" would be the true answer to a question nobody asked. What the
  // person picked is Niteshift, and that is what the Executors page should
  // say. The lifecycle marks are the ones set while `.niteshift/setup` runs;
  // the task and sandbox ids are what a machine still carries afterwards.
  NITESHIFT_LIFECYCLE_PROVISION: "niteshift",
  NITESHIFT_LIFECYCLE_RESUME: "niteshift",
  NITESHIFT_LIFECYCLE_BUILD: "niteshift",
  NITESHIFT_TASK_ID: "niteshift",
  NITESHIFT_SANDBOX_ID: "niteshift",
  E2B_SANDBOX_ID: "e2b",
  DAYTONA_SANDBOX_ID: "daytona",
  MODAL_TASK_ID: "modal",
  FLY_MACHINE_ID: "fly",
  CODESPACES: "codespaces",
  GITPOD_WORKSPACE_ID: "gitpod",
  CURSOR_AGENT: "cursor",
  CODEX_SANDBOX: "codex",
  // A container with no platform's name on it. Last, so a named platform
  // that also runs containers (all of them) is called by its name.
  CODERVIBES_CONTAINER: "container",
});

/** How long one listing of e2b's sandboxes is believed. */
const E2B_CACHE_MS = 30_000;
let e2bListing = { at: 0, key: null, ids: new Set(), promise: null };

/**
 * Whether a machine name is the id of a sandbox an e2b key can see. Null
 * when there is no key, when e2b cannot be reached, or when the name is
 * not one - the caller falls through to what it knew. Cached for a while,
 * because a session start hook asks too and a busy sandbox starts sessions
 * faster than anybody should list them. The listing is the connector's
 * (connectors/e2b.js), so the same request serves its page and its tools.
 *
 * @param {string} name
 * @param {{key?: string|null, list?: (key: string) => Promise<object[]>}} options the key to ask
 *   with - the person's connector's (connectors/e2b.js keyFor) - and, for tests, the listing itself
 */
export async function isE2bSandbox(name, { key = null, list = null } = {}) {
  if (!key || !name) return null;
  const now = Date.now();
  if (now - e2bListing.at > E2B_CACHE_MS || e2bListing.key !== key) {
    e2bListing.promise ??= (async () => {
      try {
        const listing = list ?? (await import("./connectors/e2b.js")).listSandboxes;
        const rows = await listing(key);
        const ids = new Set(rows.map((row) => String(row?.sandboxID ?? row?.sandboxId ?? "")).filter(Boolean));
        e2bListing = { at: Date.now(), key, ids, promise: null };
      } catch {
        // Unreachable: keep whatever was known, and do not ask again for a while.
        e2bListing = { at: Date.now(), key, ids: e2bListing.key === key ? e2bListing.ids : new Set(), promise: null };
      }
    })();
    await e2bListing.promise;
  }
  return e2bListing.ids.has(String(name)) ? true : null;
}

/** For tests: forget what e2b said. */
export const forgetE2b = () => {
  e2bListing = { at: 0, key: null, ids: new Set(), promise: null };
};

/**
 * The platform a machine is on.
 *
 * `platform` is what the machine said outright, if anything; `markers` the
 * platform variables it found set; `machine` its name. The first that
 * answers wins, in that order - and e2b is asked last, only when nothing
 * else said, since it costs a request. `options.key` is the e2b key to ask
 * with (connectors/e2b.js `keyFor`); without one, e2b is not asked.
 *
 * @returns {Promise<string>} a word, "laptop" when nothing says otherwise
 */
export async function platformOf({ platform = null, markers = [], machine = null } = {}, options = {}) {
  const said = String(platform ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  if (said && said !== "laptop") return said;
  // In MARKERS' order, not the machine's: a container on a named platform
  // is called by the platform's name, whichever mark the script saw first.
  const found = new Set((Array.isArray(markers) ? markers : []).map(String));
  for (const [marker, word] of Object.entries(MARKERS)) {
    if (found.has(marker)) return word;
  }
  if (await isE2bSandbox(machine, options)) return "e2b";
  return "laptop";
}
