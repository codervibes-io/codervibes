// A small modal host, shared by every repo management action.
//
// One modal is open at a time. `body` and `actions` are functions so a modal
// can redraw itself in place after an action (sharing someone, removing a
// member) without closing and losing the user's place.
const host = {
  root: null,
  spec: null,
  error: null,
  busy: false,
};

export function initModals() {
  host.root = document.getElementById("app-modal");
  host.root.addEventListener("click", (event) => {
    if (event.target === host.root) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !host.root.hidden) close();
  });
}

/**
 * @param {object} spec
 * @param {string|(ctx) => string} spec.title
 * @param {string|(ctx) => string} [spec.subtitle]
 * @param {(ctx) => Node} [spec.body] the middle of it, if it needs one
 * @param {(ctx) => Array} [spec.actions]  footer buttons, left to right
 * @param {string} [spec.width]
 * @param {() => void} [spec.onClose]
 */
export function openModal(spec) {
  host.spec = spec;
  host.error = null;
  host.busy = false;
  host.root.hidden = false;
  render();
  // Give the first field focus so the modal is usable from the keyboard.
  host.root.querySelector("input, textarea, select")?.focus();
}

export function close() {
  const onClose = host.spec?.onClose;
  host.spec = null;
  host.error = null;
  host.busy = false;
  host.root.hidden = true;
  host.root.replaceChildren();
  onClose?.();
}

const ctx = {
  close,
  update: () => render(),
  setError(message) {
    host.error = message;
    render();
  },
  setBusy(busy) {
    host.busy = busy;
    render();
  },
  /**
   * Recompute only the footer buttons. Typing in a field has to be able to
   * enable the primary action, and a full re-render would steal focus and the
   * caret position mid-keystroke.
   */
  syncActions() {
    if (!host.spec || host.root.hidden) return;
    const actions = (host.spec.actions?.(ctx) ?? []).filter((action) => !action.spacer);
    const buttons = host.root.querySelectorAll(".app-modal-footer button");
    actions.forEach((action, index) => {
      const button = buttons[index];
      if (!button) return;
      button.disabled = Boolean(host.busy || action.disabled);
      button.textContent = host.busy && action.primary ? "Working…" : action.label;
    });
  },
};

function render() {
  if (!host.spec || host.root.hidden) return;
  const spec = host.spec;

  const box = document.createElement("div");
  box.className = "modal-box app-modal-box";
  if (spec.width) box.style.width = spec.width;

  const head = document.createElement("div");
  head.className = "modal-head";
  const title = document.createElement("span");
  // A function when the name changes with the state, like the subtitle: a
  // three-step dialog is called something different on its last step.
  title.textContent = typeof spec.title === "function" ? spec.title(ctx) : spec.title;
  const closeButton = document.createElement("button");
  closeButton.textContent = "✕";
  closeButton.type = "button";
  closeButton.addEventListener("click", close);
  head.append(title, closeButton);
  box.append(head);

  // A form so Enter submits the primary action, as people expect.
  const form = document.createElement("form");
  form.className = "app-modal-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (host.busy) return;
    const actions = spec.actions?.(ctx) ?? [];
    actions.find((action) => action.primary)?.onClick?.();
  });

  // What the body was scrolled to before this render, so it can be put back.
  // Every checkbox in the share dialog calls update(), which rebuilds the
  // whole box - and without this each tick threw you back to the top, which
  // is unusable once anything worth ticking is below the fold.
  const scrolled = host.root.querySelector(".app-modal-body")?.scrollTop ?? 0;

  const body = document.createElement("div");
  body.className = "app-modal-body";
  // A function when the line depends on modal state - the share dialog says
  // something different on its person tab and its agent tab.
  const subtitleText =
    typeof spec.subtitle === "function" ? spec.subtitle(ctx) : spec.subtitle;
  if (subtitleText) {
    const subtitle = document.createElement("p");
    subtitle.className = "app-modal-subtitle";
    subtitle.textContent = subtitleText;
    body.append(subtitle);
  }
  if (host.error) {
    const error = document.createElement("div");
    error.className = "notice err";
    error.textContent = host.error;
    body.append(error);
  }
  // Optional: a modal that is only a question and two buttons has nothing to
  // put here, and the subtitle has already said everything.
  if (spec.body) body.append(spec.body(ctx));
  form.append(body);

  const actions = spec.actions?.(ctx) ?? [];
  if (actions.length) {
    const footer = document.createElement("div");
    footer.className = "app-modal-footer";
    for (const action of actions) {
      if (action.spacer) {
        const spacer = document.createElement("span");
        spacer.className = "spacer";
        footer.append(spacer);
        continue;
      }
      const button = document.createElement("button");
      button.className = action.primary
        ? `primary-btn${action.danger ? " danger" : ""}`
        : `ghost-btn${action.danger ? " danger" : ""}`;
      button.textContent = host.busy && action.primary ? "Working…" : action.label;
      button.type = action.primary ? "submit" : "button";
      button.disabled = Boolean(host.busy || action.disabled);
      if (!action.primary) button.addEventListener("click", () => action.onClick?.());
      footer.append(button);
    }
    form.append(footer);
  }

  box.append(form);
  host.root.replaceChildren(box);
  if (scrolled) body.scrollTop = scrolled;
}

/** Run an async action with the primary button in a busy state. */
export async function withBusy(fn) {
  ctx.setBusy(true);
  try {
    await fn();
  } catch (err) {
    ctx.setBusy(false);
    ctx.setError(err.message);
    return false;
  }
  ctx.setBusy(false);
  return true;
}

export { ctx as modalContext };
