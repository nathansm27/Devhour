// Shared helpers for the leaderboard and admin pages.
window.DH = (function () {
  "use strict";

  var METRICS = [
    { key: "calls", label: "Calls", one: "call", many: "calls" },
    { key: "meetings", label: "Meetings", one: "meeting", many: "meetings" },
    { key: "signups", label: "Sign-ups", one: "sign-up", many: "sign-ups" }
  ];
  var TRACK_MAX = 125; // the 100% goal marker sits at 80% of a track
  var PALETTE = [
    ["#7C8CFF", "#4B55C9"], ["#B98BFF", "#6D43C7"], ["#57D6B0", "#1F8E7A"], ["#FF9E7A", "#C4523A"],
    ["#FF86B8", "#B63D78"], ["#62C4F5", "#2A73B8"], ["#F7C75C", "#C07E1D"], ["#9AA7C7", "#56617F"]
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  function avatar(p, extra) {
    var c = PALETTE[hash(p.id) % PALETTE.length];
    return '<span class="av ' + (extra || "") + '" style="--c:' + c[0] + ";--c2:" + c[1] + '" aria-hidden="true">' + esc(initials(p.name)) + "</span>";
  }
  function fmtDate(iso, withYear) {
    var d = new Date(iso + "T12:00:00");
    if (isNaN(d)) return iso || "";
    var o = { weekday: "short", day: "numeric", month: "short" };
    if (withYear || d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-GB", o);
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function plural(n, m) { return n === 1 ? m.one : m.many; }
  function zero() { return { calls: 0, meetings: 0, signups: 0 }; }

  // Build lookup tables from the API payload.
  function model(data) {
    var m = {
      data: data,
      people: data.people,
      byId: {},
      asc: data.sessions.slice().sort(function (a, b) { return a.date.localeCompare(b.date); }),
      desc: data.sessions.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }),
      res: {}
    };
    data.people.forEach(function (p) { m.byId[p.id] = p; });
    data.results.forEach(function (r) { m.res[r.sessionId + "|" + r.personId] = r; });
    return m;
  }
  function entry(m, sid, pid) { return m.res[sid + "|" + pid] || null; }

  function pctOf(actual, goal) {
    var ratios = [];
    METRICS.forEach(function (k) { if (goal[k.key] > 0) ratios.push(Math.min(actual[k.key] / goal[k.key], 2)); });
    if (!ratios.length) return null;
    return Math.round(100 * ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length);
  }

  // Score for one person over one session, or over every session ("all").
  function score(m, pid, sid) {
    var ids = sid === "all" ? m.asc.map(function (s) { return s.id; }) : [sid];
    var a = zero(), g = zero(), n = 0;
    ids.forEach(function (id) {
      var e = entry(m, id, pid);
      if (!e) return;
      n++;
      METRICS.forEach(function (k) { a[k.key] += e[k.key] || 0; g[k.key] += (e.goals || {})[k.key] || 0; });
    });
    if (!n) return null;
    return { actual: a, goal: g, pct: pctOf(a, g), sessions: n };
  }

  function rank(m, sid) {
    var rows = m.people.map(function (p) { return { p: p, s: score(m, p.id, sid) }; });
    var logged = rows.filter(function (r) { return r.s; }).sort(function (x, y) {
      var xp = x.s.pct == null ? -1 : x.s.pct, yp = y.s.pct == null ? -1 : y.s.pct;
      return (yp - xp) || (y.s.actual.signups - x.s.actual.signups) ||
        (y.s.actual.meetings - x.s.actual.meetings) || (y.s.actual.calls - x.s.actual.calls) ||
        x.p.name.localeCompare(y.p.name);
    });
    var absent = rows.filter(function (r) { return !r.s && r.p.active; }).map(function (r) { return r.p; });
    return { logged: logged, absent: absent };
  }

  // Per-session scores for a person, oldest first, optionally up to a session.
  function history(m, pid, untilSid) {
    var out = [];
    for (var i = 0; i < m.asc.length; i++) {
      var s = m.asc[i], e = entry(m, s.id, pid);
      if (e) out.push({ session: s, entry: e, pct: pctOf(e, e.goals || zero()) });
      if (untilSid && s.id === untilSid) break;
    }
    return out;
  }
  function streak(m, pid, untilSid) {
    var h = history(m, pid, untilSid), n = 0;
    for (var i = h.length - 1; i >= 0; i--) { if (h[i].pct != null && h[i].pct >= 100) n++; else break; }
    return n;
  }

  // API
  function api(path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (opts.token) headers.authorization = "Bearer " + opts.token;
    // Vercel: every API route is served by one function at /api/router.
    var url = "/api/router?path=" + encodeURIComponent(path.replace(/^\/api\//, ""));
    return fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var err = new Error(body.error || "Request failed (" + r.status + ")"); err.status = r.status; throw err; }
        return body;
      });
    });
  }

  return {
    METRICS: METRICS, TRACK_MAX: TRACK_MAX, esc: esc, avatar: avatar, fmtDate: fmtDate, todayISO: todayISO,
    plural: plural, zero: zero, model: model, entry: entry, pctOf: pctOf, score: score, rank: rank,
    history: history, streak: streak, api: api
  };
})();
