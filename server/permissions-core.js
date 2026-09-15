// One permission per action.
//
// A repo used to grant six *capabilities* - codeViewing, codeEditing,
// codeExecution, provisioning, aiAssist and deployments - and every tool was
// filed under one of them. That was fine while the tools were nine file
// operations and a shell. It stopped being fine when "editing" also meant
// pushing to GitHub, "provisioning" also meant opening a machine to the
// internet, and a Slack message and a Linear ticket were both "a connector":
// somebody sharing a repo could not say "read the files and run the
// tests, but do not push", because there was no word for it.
//
// So the unit of permission is now the action itself, named after the tool
// that performs it: `read_file`, `run_command`, `push_to_github`,
// `slack_post_message`. Groups exist for the person ticking boxes - Files,
// Execution, Git, Deploy, Machines, Connectors - and presets exist for the
// person who does not want to tick boxes at all. Neither is the model. The
// model is: a principal holds a list of action ids, and a tool runs when its
// id is in the list.
//
// Two things follow from naming permissions after tools.
//
// **A tool cannot exist without a permission.** Every tool definition in
// tools.js, fleet-tools.js, collab-tools.js and the connectors carries a
// `permission` field - either an id in the catalogue below or `null` for the
// handful that are membership rather than privilege (seeing who is here,
// handing work around). A test holds the catalogue and the registries to the same
// set, so adding a tool without deciding what permits it fails the suite
// rather than shipping as "always allowed".
//
// **The catalogue depends on whose it is.** The platform's own actions are
// the same for everybody; a connector's actions exist only for people who
// have that connector, and a custom connector exists only for the person who
// built it. So `catalogue({ owner })` takes the owner, and reads their
// connector row synchronously - the registry needs to answer "what may this
// agent do" in the middle of an MCP call without a round trip to the store.
//
// The six capabilities survive in exactly one place: `fromCapabilities`, the
// migration. A record written before this file has `capabilities` and no
// `permissions`; it reads as the permissions those capabilities implied on
// the day this shipped, and the first time somebody edits it the list is
// written out and the object stops mattering. Nothing else in the codebase
// should mention a capability by name.
//
// ---
//
// This half is the model without the connectors: the groups, the platform's
// own actions, the presets, the migration, and the checks that read them.
// It imports nothing - no connector registry, no connector store, no
// external agents - so the modules that only need to *decide* about a grant
// (repos.js does, on every record it reads) can have the decision without
// dragging a dozen services' clients in behind it.
//
// The connector half lives in permissions.js, which re-exports all of this
// and hands the two functions below the rows it has: what connectors one
// person holds, as catalogue entries, and which of them are connected. Until
// something registers them the catalogue is the platform's own actions and
// nothing else, which is exactly right for an installation with no
// connectors in it. Importing permissions.js registers them, and everything
// that wants the whole catalogue imports permissions.js as it always did.

/** The connector half's rows, registered by permissions.js. See the essay. */
let connectorItems = () => [];
/** Which of this owner's connectors are connected, and whether the credential writes. */
let connectedServices = () => ({});

/**
 * Hand the core the connector half. Called once, by permissions.js, on the
 * way in; nothing else should call it.
 */
export function useConnectors({ items, services } = {}) {
  connectorItems = items ?? (() => []);
  connectedServices = services ?? (() => ({}));
}

/** The groups, in the order the console shows them. */
export const GROUPS = [
  { id: "git", label: "Git", hint: "Sending work out of the repo." },
  { id: "repos", label: "Repos", hint: "Working with other agents, and asking for more." },
  { id: "deploy", label: "Deploy", hint: "Putting something live. Filled by connectors that say they deploy." },
  { id: "connectors", label: "Connectors", hint: "Services the owner has connected." },
];

const GROUP_IDS = new Set(GROUPS.map((group) => group.id));



/**
 * The platform's own actions. Ids are tool names; the `sensitive` ones are
 * marked in the console and are where JIT access will hang later.
 *
 * `forAgents`/`forPeople` say who the action makes sense for: a person in the
 * console never calls `list_dir` - they have a file tree - but their
 * `read_file` is what lets the tree load, and `assistant` is theirs alone.
 */
const PLATFORM = [
  // Sending work back
  { id: "push_to_github", group: "git", label: "Open pull requests", hint: "Send changes back to the repository, as the repo's owner.", write: true },
  { id: "merge_pull_request", group: "git", label: "Merge pull requests", hint: "Merge a pull request on the repository this repo came from. Review is what this bypasses.", write: true, sensitive: true },
  // Working together
  { id: "create_repo", group: "repos", label: "Connect repos", hint: "Connect another of your repositories.", forPeople: false },
];

const entry = (raw) => ({
  id: raw.id,
  group: raw.group,
  label: raw.label,
  hint: raw.hint ?? "",
  sensitive: Boolean(raw.sensitive),
  write: Boolean(raw.write),
  deploy: Boolean(raw.deploy),
  forAgents: raw.forAgents ?? true,
  forPeople: raw.forPeople ?? true,
  connector: raw.connector ?? null,
  connected: raw.connected ?? null,
  // The connector's own name, for a sentence about the connector rather
  // than the tool: "Slack is granted but not connected".
  service: raw.service ?? null,
  platform: raw.platform ?? null,
});

export const PLATFORM_PERMISSIONS = PLATFORM.map(entry);

/** A raw row from the connector half, read the same way the platform's own are. */
export const permissionEntry = entry;

/**
 * Everything one person's principals could be granted.
 *
 * Connector actions are listed whether or not the connector is connected -
 * a grant for an unconnected one is a grant that starts working the day it
 * is connected, which is what somebody setting an agent up ahead of time
 * wants. `connected` says which it is, for the console to note.
 */
export function catalogue({ owner = null } = {}) {
  const out = PLATFORM_PERMISSIONS.map((item) =>
    item.platform ? { ...item, connected: platformConnected(item.platform) } : item,
  );
  out.push(...connectorItems(owner));
  return out;
}

/** The catalogue as a map, which is what the checks want. */
function indexed({ owner = null } = {}) {
  const map = new Map();
  for (const item of catalogue({ owner })) map.set(item.id, item);
  return map;
}

export const groupOf = (id, { owner } = {}) => indexed({ owner }).get(id)?.group ?? null;

/**
 * Presets, as functions of the catalogue: a preset is a shape, not a list,
 * because Releaser has to include whichever connector actions deploy for
 * *this* owner.
 */
/**
 * The presets, and why there are three of them for a much shorter list.
 *
 * They used to span file, execution and machine grants, which is where most
 * of a grant's surface was. None of that is granted here now - an agent's
 * tools run on its owner's own machine, under its owner's own permissions -
 * so what is left to decide is what it may do to things *outside* the repo:
 * open a pull request, merge one, reach the services its owner connected.
 *
 * Reading and handing work around are not on the list because they are not
 * grants: a member does both by being a member.
 */
export const PRESETS = {
  reader: {
    label: "Reader",
    hint: "In the room: sees who is here, takes and hands over tasks, and changes nothing outside the repo.",
    pick: () => false,
  },
  developer: {
    label: "Developer",
    hint: "Opens pull requests, and reaches the services you have connected.",
    pick: (item) => item.id === "push_to_github" || item.group === "connectors",
  },
  releaser: {
    label: "Releaser",
    hint: "A developer that can also merge and deploy.",
    pick: (item) => item.group === "git" || item.group === "deploy" || item.group === "connectors",
  },
};

export function preset(name, { owner = null, agent = true } = {}) {
  const shape = PRESETS[name];
  if (!shape) return [];
  return catalogue({ owner })
    .filter((item) => (agent ? item.forAgents : item.forPeople))
    .filter(shape.pick)
    .map((item) => item.id);
}

/**
 * The migration: what a record's `capabilities` object meant.
 *
 * This is the one table that has to stay honest to history rather than to
 * intent. Under the old model an agent of somebody who had connected Slack
 * got every Slack read tool, and the writes too if the credential allowed
 * writing - not because anybody granted it, but because that was how the
 * tools were listed. A legacy record has to keep behaving that way until it
 * is rewritten, so connected connectors are folded in here and follow the
 * connection state until then.
 */
export function fromCapabilities(caps, { owner = null, agent = true } = {}) {
  const has = (key) => Boolean(caps?.[key]);
  const out = [];
  // The file, execution and machine grants this used to map are gone with the
  // sandbox they acted on: an agent's tools run where its owner runs it now,
  // on their disk and under their own permissions, not on a machine of ours.
  // An old record that held them keeps only what still means something.
  if (has("codeEditing")) out.push("push_to_github");
  if (has("provisioning") && agent) out.push("create_repo");
  // `deployments` granted nothing by the time this shipped: the only thing it
  // ever gated was hosting, and hosting went first.
  if (agent && owner) {
    const services = connectedServices(owner);
    for (const item of catalogue({ owner })) {
      if (!item.connector || !services[item.connector]) continue;
      if (item.write && !services[item.connector].writes) continue;
      out.push(item.id);
    }
  }
  return out;
}


/** Which reads a write cannot do without. */
function implied(id, byId) {
  const item = byId.get(id);
  if (!item) return [];
  if (item.id === "merge_pull_request") return ["push_to_github"];
  // A connector write implies that connector's reads: an agent that may post
  // to a channel had better be able to see what is in it.
  if (item.connector && item.write) {
    return [...byId.values()]
      .filter((other) => other.connector === item.connector && !other.write)
      .map((other) => other.id);
  }
  return [];
}

/**
 * A list somebody sent, made into a list that can be stored: known ids only,
 * once each, with the reads that its writes imply. Unknown ids are dropped
 * rather than refused - a permission for a connector that was since deleted
 * is not an error, it is nothing.
 */
export function normalize(ids, { owner = null, agent = true } = {}) {
  const byId = indexed({ owner });
  const out = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw);
    const item = byId.get(id);
    if (!item) continue;
    if (agent ? !item.forAgents : !item.forPeople) continue;
    out.add(id);
    for (const extra of implied(id, byId)) out.add(extra);
  }
  // Catalogue order, so two equal grants stringify the same.
  return [...byId.keys()].filter((id) => out.has(id));
}

/** Everything one kind of principal could hold. Owners get this. */
export const everything = ({ owner = null, agent = true } = {}) =>
  catalogue({ owner })
    .filter((item) => (agent ? item.forAgents : item.forPeople))
    .map((item) => item.id);

/** A tool with no permission is membership; anything else needs its id listed. */
export const allows = (permissions, id) =>
  id == null || (Array.isArray(permissions) && permissions.includes(id));


/**
 * The one place a call is allowed or not.
 *
 * Today the answer is `allows`. This is a function of its own so that when a
 * sensitive action can be granted just in time - a `grants: [{id, until,
 * by}]` list on the record, consulted here - nothing else has to change. The
 * shape of a refusal already says whether asking would help.
 */
export function authorize(principal, id, { owner = null } = {}) {
  if (allows(principal?.permissions, id)) return { ok: true };
  const item = indexed({ owner }).get(id);
  return {
    ok: false,
    why: item ? `not granted ${item.label.toLowerCase()}` : `no such permission '${id}'`,
    sensitive: Boolean(item?.sensitive),
    requestable: Boolean(item),
  };
}

/**
 * A grant as people read it: one row per group that has anything in it,
 * "Files: read files, edit files (3 of 7)". For the invitation mail and the
 * chips on an agent card.
 */
export function describeGrant(permissions, { owner = null, agent = true } = {}) {
  const held = new Set(Array.isArray(permissions) ? permissions : []);
  const rows = [];
  for (const group of GROUPS) {
    const items = catalogue({ owner }).filter(
      (item) => item.group === group.id && (agent ? item.forAgents : item.forPeople),
    );
    const granted = items.filter((item) => held.has(item.id));
    if (!granted.length) continue;
    // A connector tool granted before its connector is connected is a grant
    // that starts working the day it is (catalogue); until then the tool is
    // not in anybody's list, and a description that counted it as held
    // would send an agent looking for a tool it has not got.
    const live = granted.filter((item) => item.connected !== false);
    rows.push({
      group: group.id,
      label: group.label,
      granted: granted.map((item) => item.label),
      live: live.map((item) => item.label),
      unconnected: [...new Set(granted.filter((item) => item.connected === false).map((item) => item.service))],
      of: items.length,
      sensitive: granted.some((item) => item.sensitive),
    });
  }
  return rows;
}

/** A sentence for a page or a mail. */
export const grantSentence = (permissions, options) =>
  describeGrant(permissions, options)
    .map((row) => `${row.label}: ${row.granted.join(", ")}`)
    .join(". ") || "nothing yet";

export const isGroup = (id) => GROUP_IDS.has(id);
