// What a task was done with: the tools, connectors, skills and models.
//
// The spans under a task already say all of this, one call at a time. What
// nobody can read off five hundred spans is the question the person paying
// for the agents keeps asking: which of the things we gave it did it
// actually use, and which of those kept failing. So the spans are folded
// here into one small table per task - "GitHub: 12 calls, 2 failed; the
// Linear connector once; the pr-review skill; Sonnet for 40k tokens" -
// and that table is kept on the task when it closes (agent-tasks.js), for
// the same reason its steps and its cost are: the spans expire, the task
// does not, and "was the Linear connector worth connecting" is asked of a
// month of closed tasks, not of a live one.
//
// Counts and names only. A tool's arguments are what the agent typed, and
// a task is readable by everyone who can see the repo.
import * as spans from "./spans.js";

/** Rows kept per table, so a task that called forty tools keeps the forty that mattered. */
export const MAX_ROWS = 40;

const byCalls = (a, b) => b.calls - a.calls || String(a.name ?? a.id ?? a.model).localeCompare(String(b.name ?? b.id ?? b.model));

/**
 * Fold a task's spans into the four tables.
 *
 * A `tool.call` is one tool use; the `connector.call` under it is the
 * service it went to, so a GitHub tool shows once in `tools` and once in
 * `connectors`, which is the two questions - "did it use the tool" and "did
 * the service answer". A `skill.use` is a harness saying a skill was loaded.
 * A `model.call` is one request, with the tokens it carried; a declared
 * figure (`cv.declared`, from update_task) is a model call too, with the
 * agent's own count.
 *
 * @param {object[]} records span records, as spans.js keeps them
 */
export function fold(records) {
  const tools = new Map();
  const connectors = new Map();
  const skills = new Map();
  const models = new Map();
  for (const span of records ?? []) {
    const attrs = span.attrs ?? {};
    const failed = span.ok === false;
    if (span.name === "tool.call" && attrs["cv.tool.name"]) {
      const key = String(attrs["cv.tool.name"]);
      const row = tools.get(key) ?? { name: key, kind: attrs["cv.tool.kind"] ?? span.kind ?? null, calls: 0, failed: 0 };
      row.calls += 1;
      if (failed) row.failed += 1;
      tools.set(key, row);
    } else if (span.name === "connector.call" && attrs["cv.connector.id"]) {
      const key = String(attrs["cv.connector.id"]);
      const row = connectors.get(key) ?? { id: key, calls: 0, failed: 0 };
      row.calls += 1;
      if (failed) row.failed += 1;
      connectors.set(key, row);
    } else if (span.name === "skill.use" && (attrs["cv.skill.name"] ?? attrs["cv.tool.name"])) {
      const key = String(attrs["cv.skill.name"] ?? attrs["cv.tool.name"]);
      const row = skills.get(key) ?? { name: key, calls: 0 };
      row.calls += 1;
      skills.set(key, row);
    }
    // A declared figure rides on a tool call's span (collab-tools.js), so
    // that span is both a tool use and a model figure.
    if ((span.name === "model.call" || attrs["cv.declared"] === true) && attrs["cv.model"]) {
      const key = String(attrs["cv.model"]);
      const row = models.get(key) ?? { model: key, calls: 0, tokens: 0 };
      row.calls += 1;
      row.tokens +=
        Number(attrs["cv.tokens.total"]) ||
        ["cv.tokens.input", "cv.tokens.output", "cv.tokens.cacheRead", "cv.tokens.cacheWrite"].reduce(
          (sum, name) => sum + (Number(attrs[name]) || 0),
          0,
        );
      models.set(key, row);
    }
  }
  const table = (map) => [...map.values()].sort(byCalls).slice(0, MAX_ROWS);
  return { tools: table(tools), connectors: table(connectors), skills: table(skills), models: table(models) };
}

/** The four tables for one task, from whatever spans are still around. */
export async function usedFor(taskId) {
  return fold(await spans.forTask(String(taskId)));
}

/** Whether the tables say anything at all. */
export const isEmpty = (used) =>
  !used || ["tools", "connectors", "skills", "models"].every((table) => !(used[table]?.length));
