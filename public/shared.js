// Shared helpers for the leaderboard and admin pages.
window.DH = (function () {
  "use strict";

  var PALETTE = [
    ["#7C8CFF", "#4B55C9"], ["#B98BFF", "#6D43C7"], ["#57D6B0", "#1F8E7A"], ["#FF9E7A", "#C4523A"],
    ["#FF86B8", "#B63D78"], ["#62C4F5", "#2A73B8"], ["#F7C75C", "#C07E1D"], ["#9AA7C7", "#56617F"]
  ];
  var METRIC_COLORS = ["#8E9AFF", "#C39BFF", "#56DDA6", "#FFB27A", "#FF8FBF", "#6CCBF7", "#F7CF6A", "#A9B4D6"];

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

  // Build lookup tables from the API payload.
  function model(data) {
    var m = {
      data: data,
      metrics: data.metrics,
      people: data.people,
      byId: {},
      metricById: {},
      metricOrder: {},
      asc: data.sessions.slice().sort(function (a, b) { return a.date.localeCompare(b.date); }),
      desc: data.sessions.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }),
      res: {} // "sessionId|personId" -> { metricId: {value, goal} }
    };
    data.people.forEach(function (p) { m.byId[p.id] = p; });
    data.metrics.forEach(function (x, i) { m.metricById[x.id] = x; m.metricOrder[x.id] = i; });
    data.entries.forEach(function (e) {
      var k = e.sessionId + "|" + e.personId;
      (m.res[k] = m.res[k] || {})[e.metricId] = { value: e.value, goal: e.goal };
    });
    return m;
  }
  function entry(m, sid, pid) { return m.res[sid + "|" + pid] || null; }
  function metricColor(m, id) { return METRIC_COLORS[(m.metricOrder[id] || 0) % METRIC_COLORS.length]; }
  function metricName(m, id) { return m.metricById[id] ? m.metricById[id].name : "Removed metric"; }
  function byMetricOrder(m) {
    return function (a, b) { return (m.metricOrder[a] || 0) - (m.metricOrder[b] || 0); };
  }

  // Average of each metric against its goal, each capped at 200%.
  function pctOf(lines) {
    var ratios = [];
    lines.forEach(function (l) { if (l.goal > 0) ratios.push(Math.min(l.value / l.goal, 2)); });
    if (!ratios.length) return null;
    return Math.round(100 * ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length);
  }

  // Score for one person over one session, or every session ("all"), counting only metrics with a goal.
  // Returns { lines: [{metricId, value, goal}], pct, sessions } or null when nothing is logged.
  function score(m, pid, sid) {
    var ids = sid === "all" ? m.asc.map(function (s) { return s.id; }) : [sid];
    var agg = {}, n = 0;
    ids.forEach(function (id) {
      var e = entry(m, id, pid);
      if (!e) return;
      // Numbers logged against a goal of zero don't count and aren't shown.
      var counted = Object.keys(e).filter(function (mid) { return e[mid].goal > 0; });
      if (!counted.length) return;
      n++;
      counted.forEach(function (mid) {
        var a = agg[mid] || (agg[mid] = { metricId: mid, value: 0, goal: 0 });
        a.value += e[mid].value; a.goal += e[mid].goal;
      });
    });
    if (!n) return null;
    var lines = Object.keys(agg).sort(byMetricOrder(m)).map(function (k) { return agg[k]; });
    return { lines: lines, pct: pctOf(lines), sessions: n };
  }

  function rank(m, sid) {
    var rows = m.people.map(function (p) { return { p: p, s: score(m, p.id, sid) }; });
    var logged = rows.filter(function (r) { return r.s; }).sort(function (x, y) {
      var xp = x.s.pct == null ? -1 : x.s.pct, yp = y.s.pct == null ? -1 : y.s.pct;
      return (yp - xp) || x.p.name.localeCompare(y.p.name);
    });
    var absent = rows.filter(function (r) { return !r.s && r.p.active && r.p.metrics.some(function (a) { return a.goal > 0; }); }).map(function (r) { return r.p; });
    return { logged: logged, absent: absent };
  }

  // Per-session scores for a person, oldest first, optionally up to a session.
  function history(m, pid, untilSid) {
    var out = [];
    for (var i = 0; i < m.asc.length; i++) {
      var s = m.asc[i];
      var sc = score(m, pid, s.id);
      if (sc) out.push({ session: s, score: sc, pct: sc.pct });
      if (untilSid && s.id === untilSid) break;
    }
    return out;
  }
  function streak(m, pid, untilSid) {
    var h = history(m, pid, untilSid), n = 0;
    for (var i = h.length - 1; i >= 0; i--) { if (h[i].pct != null && h[i].pct >= 100) n++; else break; }
    return n;
  }

  // Team totals per metric across logged people: [{metricId, value, goal, people}]
  function teamTotals(m, logged) {
    var t = {};
    logged.forEach(function (r) {
      r.s.lines.forEach(function (l) {
        var a = t[l.metricId] || (t[l.metricId] = { metricId: l.metricId, value: 0, goal: 0, people: [] });
        a.value += l.value; a.goal += l.goal; a.people.push({ p: r.p, value: l.value });
      });
    });
    return Object.keys(t).map(function (k) { return t[k]; }).sort(function (a, b) {
      return (b.people.length - a.people.length) || ((m.metricOrder[a.metricId] || 0) - (m.metricOrder[b.metricId] || 0));
    });
  }

  // API: every route is served by one function at /api/router.
  function api(path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (opts.token) headers.authorization = "Bearer " + opts.token;
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
    esc: esc, avatar: avatar, fmtDate: fmtDate, todayISO: todayISO, model: model, entry: entry,
    metricColor: metricColor, metricName: metricName, pctOf: pctOf, score: score, rank: rank,
    history: history, streak: streak, teamTotals: teamTotals, api: api
  };
})();
