// A date histogram: how many of something fell in each slice of a range.
//
// The Search page draws one above every list it answers with, the way a
// log tool does - the bars say *when* the matches happened, which a list
// sorted by score does not, and a bar pressed narrows the list to that
// slice. The buckets are fixed by the range rather than by the data, so
// the same range draws the same bars whatever the query, and a bar that
// is empty is still there to be read as "nothing then".
//
// The slice is an hour over a day, six hours over a week and a day over a
// month: between twenty and thirty bars, which is what fits across a
// pane and is still one bar per unit a person thinks in. Over "all time"
// - which has no width until the data says one - the same holds with
// wider slices: a week over a year or two, a month beyond that, and with
// narrower ones at the other end. An installation set up this morning has
// a range of minutes, and an hour-wide slice made that one solid block
// across the pane with the same minute written three times under it: a
// chart that says nothing about when, and reads as one that failed to
// draw. Ten minutes over an afternoon and a minute over the half hour
// keep it a chart at that size too.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The bucket width for a range: a half hour's minutes, an afternoon's ten-minutes, a day's hours, a week's quarter-days, a month's days, a year's weeks. */
export function bucketFor(rangeMs) {
  if (rangeMs <= 30 * MINUTE) return MINUTE;
  if (rangeMs <= 4 * HOUR) return 10 * MINUTE;
  if (rangeMs <= DAY) return HOUR;
  if (rangeMs <= 7 * DAY) return 6 * HOUR;
  if (rangeMs <= 120 * DAY) return DAY;
  if (rangeMs <= 2 * 365 * DAY) return 7 * DAY;
  return 28 * DAY;
}

/**
 * Where the bars start. `since` when the range has a floor; over all time
 * it has none, so the oldest thing counted sets it - and nothing counted
 * draws a day, rather than the bars from the epoch that a floor of zero
 * would ask for.
 */
function startOf(items, { since, now, at }) {
  if (Number.isFinite(since) && since > 0) return since;
  let oldest = null;
  for (const item of items) {
    const when = Number(at(item));
    if (!Number.isFinite(when) || when <= 0) continue;
    if (oldest === null || when < oldest) oldest = when;
  }
  return oldest === null ? now - DAY : oldest;
}

/**
 * Count `items` into buckets from `since` to `now` - or, when `since` is
 * not a time (all time), from the oldest item counted. `at` reads an item's
 * time; `series` names the line an item is on (`by` on the bucket), or
 * nothing for a single count. Buckets are aligned to the width, so the
 * first may start before `since` and the last after `now`.
 *
 * @returns {{ bucketMs: number, from: number, to: number, buckets: { at: number, count: number, by: object }[] }}
 */
export function histogram(items, { since, now = Date.now(), bucketMs = null, at = (item) => item.at, series = null } = {}) {
  const start = startOf(items, { since, now, at });
  const width = bucketMs ?? bucketFor(now - start);
  const from = Math.floor(start / width) * width;
  const to = Math.floor(now / width) * width + width;
  const buckets = [];
  for (let bar = from; bar < to; bar += width) buckets.push({ at: bar, count: 0, by: {} });
  for (const item of items) {
    const when = Number(at(item));
    if (!Number.isFinite(when) || when < from || when >= to) continue;
    const bucket = buckets[Math.floor((when - from) / width)];
    bucket.count += 1;
    const key = series ? series(item) : null;
    if (key) bucket.by[key] = (bucket.by[key] ?? 0) + 1;
  }
  return { bucketMs: width, from, to, buckets };
}
