// The Tools page, wired up: the list for a range, and one tool.
//
// The drawing is console-tools.js; this is what used to sit in console.js -
// the two reads and the range that is shared between them. Split out for
// the reason page-performance.js is: a shell with four pages should be able
// to have this one without having all eleven (shell.js).
import { toolsView, toolView } from "./console-tools.js";

/**
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {() => void} ctx.render
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 * @param {(path: string) => Node} ctx.back the way back to the list
 */
export function toolsPage({ state, api, render, go, pathFor, back }) {
  let loadingTools = null;
  let loadingTool = null;

  const wantsList = () => state.page === "tools" && !state.selected;
  const wantsOne = () => state.page === "tools" && Boolean(state.selected);

  /** The tools, for the range the page shows. */
  function loadTools() {
    if (loadingTools) return loadingTools;
    const { range } = state.tools;
    loadingTools = api
      .tools(range)
      .then(
        (data) => {
          if (state.tools.range === range) state.tools = { range, data, failed: null };
        },
        (err) => {
          if (state.tools.range === range) state.tools = { range, data: null, failed: err.message };
        },
      )
      .finally(() => {
        loadingTools = null;
      });
    return loadingTools;
  }

  /** One tool, by the name in the address, for the range the page shows. */
  function loadTool() {
    if (loadingTool) return loadingTool;
    const id = state.selected;
    const { range } = state.tools;
    loadingTool = api
      .tool(id, range)
      .then(
        (data) => {
          state.toolDetail = { id, range, data, failed: null };
        },
        (err) => {
          state.toolDetail = { id, range, data: null, failed: err.message };
        },
      )
      .finally(() => {
        loadingTool = null;
      });
    return loadingTool;
  }

  /** The list, or one tool with a way back to it. */
  function draw(pane) {
    if (!state.selected) {
      pane.append(
        toolsView({
          range: state.tools.range,
          data: state.tools.data,
          failed: state.tools.failed,
          onRange: (range) => {
            state.tools = { range, data: null, failed: null };
            render();
          },
          onReread: () => {
            state.tools = { ...state.tools, data: null, failed: null };
            render();
          },
          onOpen: go,
          pathFor,
        }),
      );
      return;
    }
    pane.append(back(pathFor("tools")));
    const current = state.toolDetail.id === state.selected && state.toolDetail.range === state.tools.range;
    pane.append(
      toolView({
        name: state.selected,
        range: state.tools.range,
        data: current ? state.toolDetail.data : null,
        failed: current ? state.toolDetail.failed : null,
        onRange: (range) => {
          state.tools = { range, data: null, failed: null };
          render();
        },
        onOpen: go,
        pathFor,
      }),
    );
  }

  return {
    draw,
    loadTools,
    loadTool,
    readList: () => (wantsList() && state.tools.data === null && !state.tools.failed ? loadTools() : null),
    // One tool is read again when the address names a different one, or
    // when the range moved under it - both are a different answer.
    readTool: () => (wantsOne() && (state.toolDetail.id !== state.selected || state.toolDetail.range !== state.tools.range) ? loadTool() : null),
  };
}
