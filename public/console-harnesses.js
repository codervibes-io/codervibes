// A harness that reported: one somebody declared before the account's ingest
// token existed, with a page on the Executors list.
//
// There used to be a dialog for making one, and a panel that listed them.
// Both are gone: declaring a harness was a form standing between a person
// and the only thing they wanted, which is a token and a settings file -
// see console-connect.js, which is what the Executors page offers instead.
// A record made under the old flow still works and still has this page.
import { api } from "./api.js";
import { el, button, ago, problem, detailHead, chips } from "./console-dom.js";
import { openModal } from "./modal.js";
import { connectSteps } from "./console-connect.js";
import { statsPanel } from "./console-executor-stats.js";

/** How "where it runs" reads to a person. */
const WHERE = { laptop: "on your own machine" };

/**
 * A harness of its own, as a page: one on a laptop reporting for nobody in
 * particular. What it is and where, how to connect it (the token was shown
 * once), what its sessions came to, and the way to forget it. No
 * no tasks - it is a process somebody runs, not an agent this app can
 * reach. A harness that reports *for* an agent has no page of its own: it
 * is that agent's location, on the agent's page.
 *
 * @param {object} harness a row from /api/executors of kind "harness"
 * @param {{onChanged: () => void}} args
 */
export function harnessDetail(harness, { readOnly = false, onChanged }) {
  const pane = el("div", "detail");
  const by = harness.invitedBy?.by ?? null;
  const made = harness.createdAt ? Date.parse(harness.createdAt) : null;
  pane.append(
    detailHead(
      harness.name,
      chips(
        el("span", "chip", "harness"),
        el("span", "chip", harness.harnessLabel ?? harness.harnessKind ?? "harness"),
        // Whose machine, when it is not the reader's: the demo lists
        // twenty-five people's harnesses and every one of them would
        // otherwise say "your own".
        el("span", "chip chip-none", readOnly ? harness.location?.label ?? "a laptop" : WHERE.laptop),
        harness.lastAt
          ? el("span", "chip chip-ok", `heard from ${ago(harness.lastAt)}`)
          : el("span", "chip chip-none", "never heard from"),
        by ? `made by ${by}${made ? ` · ${ago(made)}` : ""}` : null,
      ),
    ),
  );

  // Nothing to connect or forget when it is not yours: the demo shows
  // somebody else's harness (server/index.js `readersOf`), whose steps
  // carry a token this reader does not hold and whose Forget is theirs.
  if (readOnly) {
    pane.append(statsPanel(harness.id, { name: harness.name }));
    return pane;
  }

  const connect = el("section", "console-panel");
  connect.append(el("h3", "panel-heading", "Connecting it"));
  connect.append(
    el(
      "p",
      "console-hint",
      "It sends its telemetry here and its sessions count with everybody else's. " +
        "Its token was shown once, when it was made, and is kept only as a hash: " +
        "the steps say where to point it, and if the token is lost, forget this " +
        "one and make another.",
    ),
  );
  const said = el("div", "row-body");
  const acts = el("div", "row-edit-actions");
  acts.append(
    button("ghost-btn", "Connect steps", async () => {
      try {
        const { steps } = await api.harnessConnect(harness.id);
        connectModal({ ...harness, where: "laptop" }, steps);
      } catch (err) {
        said.replaceChildren(problem(err.message));
      }
    }),
  );
  acts.append(
    button("danger-btn row-forget", "Forget", async () => {
      try {
        await api.removeHarness(harness.id);
        onChanged();
      } catch (err) {
        said.replaceChildren(problem(err.message));
      }
    }),
  );
  connect.append(acts, said);
  pane.append(connect);

  pane.append(statsPanel(harness.id, { name: harness.name }));
  return pane;
}

/** One line: the name, what it is and where, the default mark, and what can be done to it. */
function harnessRow(harness, { onChanged }) {
  const row = el("div", "row harness-row");
  row.append(el("span", "row-name", harness.name));

  const chips = el("span", "row-chips");
  // The built-in loop is called what it is; a chip saying so again is noise.
  if ((harness.kindLabel ?? harness.kind) !== harness.name) chips.append(el("span", "chip", harness.kindLabel ?? harness.kind));
  chips.append(el("span", "chip chip-none", WHERE[harness.where] ?? harness.where));
  if (harness.default) chips.append(el("span", "chip chip-ok", "default"));
  if (harness.implied) chips.append(el("span", "chip chip-warn", "from your Secrets page"));
  if (harness.lastSeenAt) chips.append(el("span", "chip chip-none", `heard from ${ago(harness.lastSeenAt)}`));
  row.append(chips);

  const note = harness.builtIn
    ? "Every account has this one; it needs nothing connected."
    : harness.implied
      ? "You have a CLAUDE_CODE_OAUTH_TOKEN and no harness of your own, so your residents run as Claude Code. Make a harness to choose otherwise."
      : null;
  if (note) row.append(el("span", "row-note", note));

  const said = el("div", "row-body");
  const acts = el("span", "row-edit-actions");
  if (!harness.builtIn && !harness.implied) {
    acts.append(
      button("ghost-btn", "Connect", async () => {
        try {
          const { steps } = await api.harnessConnect(harness.id);
          connectModal(harness, steps);
        } catch (err) {
          said.replaceChildren(problem(err.message));
        }
      }),
    );
    if (!harness.default) {
      acts.append(
        button("ghost-btn", "Make default", async () => {
          try {
            await api.defaultHarness(harness.id);
            onChanged();
          } catch (err) {
            said.replaceChildren(problem(err.message));
          }
        }),
      );
    }
    acts.append(
      button("danger-btn row-forget", "Forget", async () => {
        try {
          await api.removeHarness(harness.id);
          onChanged();
        } catch (err) {
          said.replaceChildren(problem(err.message));
        }
      }),
    );
  }
  row.append(acts);
  row.append(said);
  return row;
}

/** The connect steps again, without the token - it was shown once. */
function connectModal(harness, steps) {
  openModal({
    title: `Connect ${harness.name}`,
    subtitle:
      harness.where === "laptop"
        ? "The token was shown when this harness was made and is kept only as a hash. Forget it and make another if it is lost."
        : "",
    width: "560px",
    body: () => connectSteps(steps, { numbered: steps.length > 1 }),
    actions: (ctx) => [{ label: "Done", primary: true, onClick: () => ctx.close() }],
  });
}

