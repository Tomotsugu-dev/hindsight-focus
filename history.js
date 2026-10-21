// Foreground observations, independent of timer blocks. No host history API is available:
// only focus events received during this worker session establish known activity.
(() => {
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const GAP_MS = 45 * 1000;
  const PROJECT_MS = 15 * 1000;
  const MAX_SEGMENTS = 1200;
  const SEGMENT_BYTES = 480000;
  const KINDS = ["work", "slack", "neutral", "away"];
  const integer = (n, fallback = 0) => Number.isFinite(n) ? Math.floor(n) : fallback;
  const bytes = (text) => [...text].reduce((n, c) => n + (c.codePointAt(0) <= 0x7f ? 1 : c.codePointAt(0) <= 0x7ff ? 2 : c.codePointAt(0) <= 0xffff ? 3 : 4), 0);

  // Byte limits also bound non-Latin names. Strip control characters before JSON encoding.
  function text(value, limit) {
    if (typeof value !== "string") return null;
    let out = "";
    let size = 0;
    for (const c of value.replace(/[\u0000-\u001f\u007f]/g, "")) {
      const length = bytes(c);
      if (size + length > limit) break;
      out += c;
      size += length;
    }
    return out || null;
  }

  function detail(input) {
    const kind = KINDS.includes(input.kind) ? input.kind : "neutral";
    const c = input.category;
    return {
      kind,
      app: kind === "away" ? null : text(input.app, 96),
      category: kind === "away" || !c ? null : {
        id: text(c.id, 48),
        superId: text(c.superId ?? c.superCategory?.id, 48),
        name: text(c.name, 64),
        superName: text(c.superName ?? c.superCategory?.name, 64),
        color: /^#[0-9a-f]{6}$/i.test(c.superCategory?.color ?? c.color) ? (c.superCategory?.color ?? c.color) : null,
      },
    };
  }

  const same = (a, b) => a.kind === b.kind && a.app === b.app && JSON.stringify(a.category) === JSON.stringify(b.category);

  function append(segments, segment) {
    if (segment.end <= segment.start) return;
    const last = segments.at(-1);
    if (last && last.end === segment.start && same(last, segment)) last.end = segment.end;
    else segments.push(segment);
  }

  function cleanSegments(input, from, to) {
    const result = [];
    const sorted = (Array.isArray(input) ? input : []).filter((g) => g && Number.isFinite(g.start) && Number.isFinite(g.end))
      .map((g) => ({ start: Math.max(from, integer(g.start)), end: Math.min(to, integer(g.end)), ...detail(g) }))
      .filter((g) => g.end > g.start).sort((a, b) => a.start - b.start || a.end - b.end);
    for (const g of sorted) {
      // Earlier observations win if malformed/persisted input overlaps. Never double count.
      g.start = Math.max(g.start, result.at(-1)?.end ?? from);
      append(result, g);
    }
    return result;
  }

  function trim(history, now) {
    const segments = cleanSegments(history.segments, now - RETENTION_MS, now).slice(-MAX_SEGMENTS);
    let size = 0;
    let first = segments.length;
    for (let i = segments.length - 1; i >= 0; i--) {
      size += bytes(JSON.stringify(segments[i])) + 1;
      if (size > SEGMENT_BYTES) break;
      first = i;
    }
    history.segments = segments.slice(first);
    return history;
  }

  function fresh(now) {
    return { version: 1, sessionId: null, sessionStartedAt: now, observedSince: null, lastEventAt: null,
      updatedAt: now, focus: null, segments: [] };
  }

  /** boot starts an unknown interval. focus carries the source event's at plus kind/app/category.
   * now is when the worker received it; tick carries only sessionId. Inputs never mutate prev. */
  function reduce(prev, input, now = Date.now()) {
    now = integer(now);
    const h = prev?.version === 1 ? JSON.parse(JSON.stringify(prev)) : fresh(now);
    h.segments = cleanSegments(h.segments, now - RETENTION_MS, now);
    if (input.type === "boot") {
      h.sessionId = text(input.sessionId, 96);
      h.sessionStartedAt = now;
      h.observedSince = null;
      h.lastEventAt = null;
      h.updatedAt = now;
      h.focus = null;
      return trim(h, now);
    }
    if (!h.sessionId || input.sessionId !== h.sessionId || now < h.updatedAt) return trim(h, now);
    const gap = now - h.updatedAt > GAP_MS;
    if (gap) {
      h.focus = null;
      h.observedSince = null;
    }
    if (h.focus) append(h.segments, { start: Math.max(h.updatedAt, h.focus.since), end: now, ...detail(h.focus) });

    if (input.type === "focus" && Number.isFinite(input.at)) {
      const at = Math.min(now, integer(input.at));
      // Delayed older events cannot replace the last accepted focus. A new observed stretch
      // begins on receipt, so it never invents activity before startup or after a sleep gap.
      if (h.lastEventAt === null || at >= h.lastEventAt) {
        const start = h.focus ? Math.max(at, h.observedSince, h.sessionStartedAt) : now;
        h.segments = h.segments.filter((g) => g.start < start).map((g) => ({ ...g, end: Math.min(g.end, start) }));
        const value = detail(input);
        append(h.segments, { start, end: now, ...value });
        h.focus = { since: start, ...value };
        h.observedSince ??= now;
        h.lastEventAt = at;
      }
    }
    h.updatedAt = now;
    return trim(h, now);
  }

  /** A half-open wall-clock interval. Unknown coverage is separate from observed away time.
   * The latest observation may be projected by at most one normal heartbeat, never across a gap. */
  function range(history, from, to, { now = Date.now(), projectMs = PROJECT_MS } = {}) {
    from = integer(from);
    to = Math.max(from, integer(to, from));
    const list = [...(history?.segments ?? [])];
    const last = history?.updatedAt;
    if (history?.version === 1 && history.focus && Number.isFinite(last) && now >= last && now - last <= GAP_MS) {
      const end = Math.min(now, last + Math.max(0, Math.min(PROJECT_MS, integer(projectMs))));
      list.push({ start: last, end, ...detail(history.focus) });
    }
    const segments = cleanSegments(list, from, to);
    const result = { from, to, segments, knownMs: 0, unknownMs: 0, workMs: 0, slackMs: 0, neutralMs: 0, awayMs: 0 };
    for (const g of segments) {
      const ms = g.end - g.start;
      result.knownMs += ms;
      result[`${g.kind}Ms`] += ms;
    }
    result.unknownMs = to - from - result.knownMs;
    return result;
  }

  globalThis.FocusHistory = { reduce, range, summarize: range, RETENTION_MS, GAP_MS, PROJECT_MS, MAX_SEGMENTS };
})();
