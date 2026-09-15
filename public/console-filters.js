// The one control every filter on this console is: a button that says what
// is picked, and a list under it you can type into.
//
// It was chips. Every filter laid all of its options out as buttons, which
// is honest and reads at a glance while there are four of them - and there
// are four of them on a laptop with a demo workspace. On a real
// installation the Repo filter is one chip per repository the team has
// touched and the Executor filter one per agent anybody has run, so the
// page opened on two wrapped lines of chips before the first row of the
// thing being filtered. The options were also the only way to reach an
// option: to narrow to `kubernetes-sigs/external-dns` you read thirty
// names looking for it, and on a phone you read them two to a line.
//
// So: a dropdown, and the list inside it narrows as you type, by the same
// fuzzy rule the model box uses (`fuzzyScore` below, which lived in
// console-models.js until this control wanted it too) - every letter in
// order, gaps and a late start cost. "extdns" finds
// kubernetes-sigs/external-dns; "son" finds claude-sonnet-5 before
// anything that merely has an s, an o and an n.
//
// The box only appears past `SEARCH_FROM` options. Under that a list is
// read faster than it is typed, and a search box over four rows is a
// control that costs a keystroke to skip.
//
// What the button says is the whole of what the filter is doing, because
// nothing else on the page shows it any more - a chip row at least left
// the unpressed options visible. So a filter that is set says so twice:
// the picked label on the button, and `is-set` on the wrapper, which is
// the same colour a pressed chip was.
import { el, button } from "./console-dom.js";

/**
 * How well `query` fits `text`, or null when it does not.
 *
 * Every letter of the query has to appear in the text, in order. Fewer and
 * shorter gaps between them is a better fit, a match at the start of the
 * text or right after a separator is better still - so "son" puts
 * claude-sonnet-5 before anything that merely has an s, an o and an n.
 * Lower is better; exported so the ordering can be proved without a DOM.
 */
export function fuzzyScore(query, text) {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const hay = String(text ?? "").toLowerCase();
  if (!needle) return 0;
  let score = 0;
  let at = -1;
  for (const char of needle) {
    const next = hay.indexOf(char, at + 1);
    if (next === -1) return null;
    if (at === -1) score += next === 0 ? 0 : /[-._ /]/.test(hay[next - 1]) ? 1 : 3;
    else score += next === at + 1 ? 0 : 2 + Math.min(next - at - 1, 8);
    at = next;
  }
  // Between two that fit equally, the shorter - "gpt5" is gpt-5 before it
  // is gpt-5-mini.
  return score + hay.length / 1000;
}

/**
 * The entries `typed` leaves, best fit first; all of them, in the order
 * they came, when nothing is typed.
 *
 * An entry is matched on its label and on its key, because the two are
 * often different things a person might type - a session's executor is
 * "Nomad" on the row and `agt_01H…` in the address, and a repo is
 * "external-dns" and `kubernetes-sigs/external-dns`.
 *
 * `search` is a third string an entry may carry: words that are neither its
 * name nor its id and are never shown, for a list where half of what
 * somebody types is not in either. The setup dialog's tools are that list -
 * "openai" is nowhere in "Codex" - and a hit there is scored a little worse
 * than one on the name, so typing "amp" reaches Amp before it reaches
 * something that merely lists an a, an m and a p among its other names.
 *
 * Exported so the ordering can be proved without a DOM.
 */
export function narrow(entries, typed) {
  const query = String(typed ?? "").trim();
  if (!query) return [...entries];
  const scored = [];
  for (const entry of entries) {
    const aside = entry.search ? fuzzyScore(query, entry.search) : null;
    const score = Math.min(
      fuzzyScore(query, entry.label) ?? Infinity,
      entry.key == null ? Infinity : fuzzyScore(query, String(entry.key)) ?? Infinity,
      aside == null ? Infinity : aside + 4,
    );
    if (score !== Infinity) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((row) => row.entry);
}

/** Past this many options the list gets a box to type into; under it, it does not. */
export const SEARCH_FROM = 7;

/**
 * A filter, as a labelled dropdown.
 *
 * `entries` are `{key, label, note}` - the note is the dim half of a row,
 * the count on a search kind or anything else that is context rather than
 * name. `picked` is a key, or null. When `all` is a string the list gets
 * that row first, standing for no pick, and `onPick` is told null for it;
 * pass `all: null` for a filter that is always one of its options, like
 * the range or whose work the page shows.
 *
 * The caller redraws: `onPick` is told the new key and nothing here
 * changes, so a filter looks picked when the thing it filters has caught
 * up, and never before.
 *
 * @param {object} args
 * @param {string} args.label the quiet word beside it
 * @param {{key: string, label: string, note?: string}[]} args.entries
 * @param {string|null} args.picked
 * @param {(key: string|null) => void} args.onPick
 * `multi` makes it a set rather than a pick: `picked` is an array of keys,
 * a row toggles instead of choosing, `onPick` is told the new array, and
 * the list stays open so two can be turned on in one go. There is no All
 * row on one of those - the empty set is what All would have meant, and
 * `none` is what the button says when it is empty.
 *
 * @param {object} args
 * @param {string} args.label the quiet word beside it
 * @param {{key: string, label: string, note?: string, title?: string,
 *   search?: string, icon?: () => Node}[]} args.entries
 * @param {string|string[]|null} args.picked a key, or the keys when `multi`
 * @param {(picked: string|string[]|null) => void} args.onPick
 * @param {string|null} args.all the "no pick" row's words, or null for none
 * @param {boolean} args.multi whether more than one can be on at once
 * @param {string} args.none what the button says with nothing on, when `multi`
 * @param {string} args.find the box's placeholder, when there is a box
 */
export function filterPicker({ label, entries, picked = null, onPick, all = "All", multi = false, none = "None", find = "Type to narrow" }) {
  const on = new Set(multi ? picked ?? [] : []);
  const options = all == null || multi ? [...entries] : [{ key: null, label: all }, ...entries];
  const isOn = (entry) => (multi ? on.has(entry.key) : entry.key === picked);
  const chosen = multi ? null : options.find((entry) => entry.key === picked) ?? options[0];
  /** What the closed button says: the picked one, or everything that is on. */
  const facing = () => (multi ? options.filter(isOn).map((entry) => entry.label).join(", ") || none : chosen?.label ?? all ?? "");

  const root = el("div", "filter-picker");
  if (multi ? on.size > 0 : picked != null && all != null) root.classList.add("is-set");
  if (label) root.append(el("span", "filter-picker-label", label));

  const shell = el("div", "filter-picker-shell");
  const face = button("filter-picker-btn", "", () => (open ? close() : show()));
  face.append(el("span", "filter-picker-value", facing()));
  if (chosen?.note) face.append(el("span", "filter-picker-note", chosen.note));
  // The caret is drawn, not typed: a glyph would be read out by a screen
  // reader as a word in the middle of the button's name.
  const caret = el("span", "filter-picker-caret");
  caret.setAttribute("aria-hidden", "true");
  face.append(caret);
  face.setAttribute("aria-haspopup", "listbox");
  face.setAttribute("aria-expanded", "false");
  if (label) face.setAttribute("aria-label", `${label}: ${facing()}`);

  const pop = el("div", "filter-picker-pop");
  pop.hidden = true;
  const box = el("input", "filter-picker-find");
  box.type = "search";
  box.placeholder = find;
  box.setAttribute("aria-label", label ? `Narrow ${label.toLowerCase()}` : "Narrow the list");
  const list = el("div", "filter-picker-list");
  list.setAttribute("role", "listbox");
  if (multi) list.setAttribute("aria-multiselectable", "true");
  // Focusable so a short list - one with no box above it - still takes the
  // arrow keys, and so tabbing out of it shuts the thing.
  list.tabIndex = -1;
  if (options.length > SEARCH_FROM) pop.append(box);
  pop.append(list);

  shell.append(face, pop);
  root.append(shell);

  let open = false;
  let shown = options;
  let active = 0;

  /** The rows, narrowed by what is typed, with one of them active. */
  function draw() {
    shown = narrow(options, box.value);
    if (!shown.length) {
      list.replaceChildren(el("p", "filter-picker-none", "Nothing goes by that."));
      return;
    }
    active = Math.max(0, Math.min(active, shown.length - 1));
    list.replaceChildren(
      ...shown.map((entry, at) => {
        const row = button("filter-picker-option", "", () => pick(entry));
        // A set needs a box: with two rows on, "picked" as a background
        // alone reads as a hover on whichever the cursor is over.
        if (multi) row.append(el("span", `filter-picker-tick${isOn(entry) ? " is-on" : ""}`));
        // A mark, where the entries are things with one - the setup dialog's
        // tools. A factory, not a node: this list is redrawn on every
        // keystroke and one node cannot be in two of them.
        if (entry.icon) row.append(entry.icon());
        row.append(el("span", "filter-picker-option-name", entry.label));
        if (entry.note) row.append(el("span", "filter-picker-note", entry.note));
        if (entry.title) row.title = entry.title;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(isOn(entry)));
        if (isOn(entry)) row.classList.add("is-picked");
        if (at === active) row.classList.add("is-active");
        return row;
      }),
    );
  }

  function move(by) {
    if (!shown.length) return;
    active = (active + by + shown.length) % shown.length;
    draw();
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function pick(entry) {
    // A set toggles and stays open: turning on both extras should not
    // cost two trips through the button. What the caller does with the
    // new set is its own business - Activity re-reads the page, and that
    // redraw closes this, which is the same thing a chip press did.
    if (multi) {
      if (on.has(entry.key)) on.delete(entry.key);
      else on.add(entry.key);
      face.querySelector(".filter-picker-value").textContent = facing();
      root.classList.toggle("is-set", on.size > 0);
      draw();
      onPick([...on]);
      return;
    }
    close();
    // Pressing the picked one is unpicking it, back to All - the chips
    // behaved that way and it is the quickest way out of a filter. A
    // picker with no All row has no "none" to go to, so it stands.
    if (entry.key === picked && all != null) onPick(null);
    else onPick(entry.key);
  }

  /** A press anywhere else shuts it. Detached from a redraw, the listener takes itself off. */
  function elsewhere(event) {
    if (!root.isConnected) return document.removeEventListener("pointerdown", elsewhere, true);
    if (!root.contains(event.target)) close();
  }

  function show() {
    open = true;
    pop.hidden = false;
    face.setAttribute("aria-expanded", "true");
    box.value = "";
    active = Math.max(0, shown.findIndex(isOn));
    draw();
    document.addEventListener("pointerdown", elsewhere, true);
    // The box when there is one, else the list, so the arrows work either way.
    (pop.contains(box) ? box : list).focus?.();
  }

  function close() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    face.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", elsewhere, true);
  }

  box.addEventListener("input", () => {
    active = 0;
    draw();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      // And stop it here. The modal host shuts the dialog on an Escape it
      // hears at the document, and `preventDefault` does not stop it
      // hearing one: inside a dialog - the setup dialog has two of these -
      // Escape shut the list and the dialog around it in one keystroke,
      // which is the whole of somebody's place lost to closing a dropdown.
      event.stopPropagation();
      close();
      face.focus();
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" && event.target === face) {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "ArrowDown") return event.preventDefault(), move(1);
    if (event.key === "ArrowUp") return event.preventDefault(), move(-1);
    if (event.key === "Enter" && shown[active]) {
      event.preventDefault();
      pick(shown[active]);
    }
  });
  // Tabbing out of the last thing in it shuts it, so a filter left open is
  // never sitting over the rows a reader has moved on to.
  root.addEventListener("focusout", (event) => {
    if (open && !root.contains(event.relatedTarget)) close();
  });

  draw();
  return root;
}

/**
 * A row of pickers - what a page's filters are, together. One line each on
 * a phone, wrapping side by side where there is room.
 */
export function filterRow(...pickers) {
  const row = el("div", "filter-row");
  row.append(...pickers.filter(Boolean));
  return row;
}
