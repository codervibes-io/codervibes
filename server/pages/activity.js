// The Activity page: what is being worked on this minute, and what finished
// lately.
//
// One route, /api/home - the address it had when it was the Home page, and
// which every console still reads. The sessions in scope over the last
// month, split into the live ones (with what each is doing this second,
// `nowOf`) and the ended ones (a row each, without the paths and trace ids
// that only a session's own page shows), and then whatever is waiting on a
// person, which is the entry point's to say: a task on a review, a request
// to decide, a call held for approval, an open pull request. The cloud
// answers those from its tasks and its connectors (index.js `waitingRows`);
// an installation that hands out no tasks answers nothing, and the page is
// drawn without the section.
import * as performance from "../performance.js";
import * as telemetry from "../telemetry.js";
import { describeSession, nowOf } from "./sessions.js";

/**
 * How far back "Finished recently" reaches, and how many rows it carries.
 * It was a week and thirty rows, and a week of one person's own setups
 * reporting every terminal is more than thirty sessions - Monday's work was
 * off the page by Wednesday, which read as the activity not being kept at
 * all. A month and five thousand is the most any page asks the store for
 * (the Performance ranges, the Executors memory), so nothing this page
 * shows is missing from the pages beside it.
 */
const RANGE_MS = performance.RANGES["30d"];
const ROWS = 5000;

export function mount(app, scope) {
  const { wrap, requireViewer } = scope;

  app.get("/api/home", requireViewer, wrap(async (req, res) => {
    const since = Date.now() - RANGE_MS;
    const [sessions, records] = await Promise.all([
      scope.sessionsInScope(req, { since, limit: ROWS }),
      scope.pullsInScope(req, { since, limit: 1000 }),
    ]);
    const names = await scope.namesOf(sessions.map((session) => session.owner));
    const describe = (session) => describeSession(scope, session, { pulls: records, names, user: req.cv.user });
    const byPullId = new Map(records.map((record) => [record.id, record]));
    const working = sessions
      .filter((session) => session.state === "live")
      .sort((a, b) => (b.lastSeenAt ?? b.startedAt ?? 0) - (a.lastSeenAt ?? a.startedAt ?? 0))
      .map((session) => ({ ...describe(session), now: nowOf(scope, session, req.cv.user, { pulls: byPullId }) }));
    // A finished row is a line in a table, and there can be thousands of
    // them. The paths it touched and the trace ids behind its counts are
    // the session page's to show, and `now` is what a live card asks; none
    // of them goes on a row that has never drawn one.
    const finished = sessions
      .filter((session) => session.state !== "live")
      .sort((a, b) => (b.endedAt ?? b.lastSeenAt ?? 0) - (a.endedAt ?? a.lastSeenAt ?? 0))
      .slice(0, ROWS)
      .map((session) => {
        const { files, traceIds, ...row } = describe(session);
        return row;
      });
    // What is waiting on a person: the one list on this page that asks
    // something of the reader rather than telling them. Oldest wait first -
    // the one somebody has been waiting on longest is the one to answer
    // first.
    const waiting = (await scope.waitingRows(req, { sessions, records }))
      .sort((a, b) => String(a.waitingOn.since).localeCompare(String(b.waitingOn.since)));
    res.json({ since, working, finished, waiting, telemetry: telemetry.describe() });
  }));
}
