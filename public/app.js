(function () {
  "use strict";
  var D = window.DH, esc = D.esc;
  var REFRESH_MS = 30000;

  var m = null, lastJSON = "", sel = null, openId = null, intro = true, lastOk = 0, failed = false;
  var teamParam = new URLSearchParams(location.search).get("team") || "";
  var $ = function (id) { return document.getElementById(id); };

  var ICON = {
    flame: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6.3.6c.3 1.7-.5 2.6-1.3 3.5C4.2 5 3 6 3 7.7 3 9.6 4.4 11 6 11s3-1.3 3-3.2c0-1.1-.5-1.9-1-2.5 0 .9-.4 1.5-1 1.7.4-2.3-.1-4.9-.7-6.4Z"/></svg>',
    check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m2.5 6.3 2.2 2.2 4.8-5"/></svg>',
    star: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="m6 .8 1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>',
    crown: '<svg class="crown" viewBox="0 0 30 22" aria-hidden="true"><path fill="#FFCF5C" d="M2 6.5 8.5 12 15 2l6.5 10L28 6.5 25.5 20h-21z"/><circle cx="2" cy="5.5" r="2" fill="#FFCF5C"/><circle cx="28" cy="5.5" r="2" fill="#FFCF5C"/><circle cx="15" cy="2" r="2" fill="#FFCF5C"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m3.5 3.5 9 9m0-9-9 9"/></svg>',
    list: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 6h6M5 9h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    trophy: '<svg viewBox="0 0 34 34" aria-hidden="true"><defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9CEFF"/><stop offset="1" stop-color="#6E7AEE"/></linearGradient></defs><path fill="url(#tg)" d="M9 4h16v6.5a8 8 0 0 1-16 0z"/><path fill="none" stroke="#9AA4FF" stroke-width="2" d="M9 7H5.5a3.5 3.5 0 0 0 3.8 5.4M25 7h3.5a3.5 3.5 0 0 1-3.8 5.4"/><rect x="15" y="18" width="4" height="6" fill="#7E8AF2"/><rect x="10.5" y="24" width="13" height="5" rx="1.6" fill="url(#tg)"/></svg>',
    empty: '<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="20" fill="rgba(142,154,255,.14)"/><rect x="16" y="34" width="8" height="14" rx="3" fill="#8E9AFF" opacity=".35"/><rect x="28" y="26" width="8" height="22" rx="3" fill="#8E9AFF" opacity=".6"/><rect x="40" y="16" width="8" height="32" rx="3" fill="#8E9AFF"/></svg>'
  };

  // ---------- data ----------
  function load() {
    return D.api("/api/data", { query: { team: teamParam } }).then(function (data) {
      lastOk = Date.now(); failed = false;
      var copy = Object.assign({}, data); delete copy.updatedAt;
      var j = JSON.stringify(copy);
      if (j !== lastJSON) { lastJSON = j; m = D.model(data); render(); }
      updateLive();
    }, function (err) {
      if (err.status === 404 && !m) {
        lastOk = Date.now();
        $("main").innerHTML = emptyHTML("Team not found", "This link doesn\u2019t match a team. Check the link or open the main leaderboard.") +
          '<p style="text-align:center;margin-top:16px"><a class="btn" href="/">Open the leaderboard</a></p>';
        $("side").innerHTML = "";
        updateLive();
        return;
      }
      failed = true; updateLive();
      if (!m) {
        $("main").innerHTML = emptyHTML("Can\u2019t load results", "Check your connection. The page will try again shortly.");
        $("side").innerHTML = "";
      }
    });
  }

  function updateLive() {
    var el = $("live");
    if (!lastOk) { el.className = "live stale"; el.lastChild.textContent = failed ? "Offline" : "Loading"; return; }
    var mins = Math.floor((Date.now() - lastOk) / 60000);
    el.className = "live" + (failed ? " stale" : "");
    el.lastChild.textContent = failed ? "Offline, retrying" : mins < 1 ? "Live" : "Updated " + mins + " min ago";
  }

  // ---------- selection ----------
  function readHash() {
    var h = decodeURIComponent(location.hash.slice(1));
    if (h === "all") return "all";
    if (m && m.desc.some(function (s) { return s.id === h; })) return h;
    return m && m.desc.length ? m.desc[0].id : "all";
  }
  function setSel(v) {
    history.replaceState(null, "", "#" + encodeURIComponent(v));
    render();
  }
  function sessionById(id) { return m.desc.filter(function (s) { return s.id === id; })[0]; }
  function selLabel(long) {
    if (sel === "all") return "All time";
    var s = sessionById(sel);
    return (s.id === m.desc[0].id && !long ? "Latest session" : D.fmtDate(s.date, long));
  }
  // "Cold calls" -> "cold calls", but keep words like "LinkedIn" or "CRM" as written.
  function softLower(s) {
    return /^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+[A-Z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
  }
  function firstName(p) {
    var parts = p.name.split(/\s+/);
    return parts.length > 1 ? parts[0] + " " + parts[parts.length - 1][0] + "." : p.name;
  }

  // ---------- render ----------
  function render() {
    document.title = m.data.team.name + " \u2013 " + m.data.title;
    $("title").textContent = m.data.title;
    var teams = m.data.teams || [];
    $("teams").hidden = teams.length < 2;
    $("teams").innerHTML = teams.map(function (t, i) {
      var href = i === 0 ? "/" : "/?team=" + encodeURIComponent(t.slug);
      return '<a href="' + href + '"' + (t.id === m.data.team.id ? ' aria-current="page"' : "") + ">" + esc(t.name) + "</a>";
    }).join("");
    sel = readHash();

    if (!m.people.length || !m.desc.length) {
      $("main").innerHTML = emptyHTML("No results yet", "The leaderboard fills up after the first development hour is logged.");
      $("side").innerHTML = "";
      intro = false;
      return;
    }

    var r = D.rank(m, sel);
    var h = "";
    if (r.logged.length) h += podiumHTML(r.logged.slice(0, 3));
    h += boardHTML(r);
    if (r.logged.length) {
      h += '<p class="foot">Each score averages that person\u2019s metrics against their own goals. The line under each row fills at 100%.</p>';
    }
    var main = $("main");
    main.className = intro ? "intro" : "";
    main.innerHTML = h;
    $("side").innerHTML = sideHTML(r);
    intro = false;
    if (openId) renderSheet(false);
  }

  function emptyHTML(title, text) {
    return '<div class="empty">' + ICON.empty + "<h2>" + esc(title) + "</h2><p>" + esc(text) + "</p></div>";
  }

  function podiumHTML(top) {
    return '<div class="podium" aria-label="Top three">' + [1, 0, 2].map(function (i) {
      var x = top[i], cls = "pl p" + (i + 1);
      if (!x) return '<div class="' + cls + ' gone"><div class="top"></div><div class="block" aria-hidden="true">' + (i + 1) + "</div></div>";
      var hit = x.s.pct != null && x.s.pct >= 100;
      return '<div class="' + cls + (hit ? " hit" : "") + '"><button class="top" data-open="' + x.p.id + '" aria-label="' +
        esc(x.p.name) + ", place " + (i + 1) + '">' + (i === 0 ? ICON.crown : "") + D.avatar(x.p) +
        '<span class="pn">' + esc(x.p.name) + '</span><span class="pill-score num">' + (x.s.pct == null ? "\u2013" : x.s.pct + "%") +
        '</span></button><div class="block" aria-hidden="true">' + (i + 1) + "</div></div>";
    }).join("") + "</div>";
  }

  function boardHTML(r) {
    var mode = sel === "all" ? "all" : "session";
    var h = '<section class="board"><div class="board-bar"><span class="bt">' + ICON.list + (mode === "all" ? "All-time leaderboard" : "Session leaderboard") + "</span>" +
      '<div class="ctrls">';
    if (mode === "session" && m.desc.length > 1) {
      h += '<label class="sr" for="pick">Session</label><select class="field pick" id="pick">' + m.desc.map(function (s, i) {
        return '<option value="' + s.id + '"' + (s.id === sel ? " selected" : "") + ">" + esc(D.fmtDate(s.date)) + "</option>";
      }).join("") + "</select>";
    }
    h += '<div class="seg" role="group" aria-label="Period"><button data-mode="session" aria-pressed="' + (mode === "session") + '">Session</button>' +
      '<button data-mode="all" aria-pressed="' + (mode === "all") + '">All time</button></div></div></div>';

    if (!r.logged.length) {
      return h + '<div class="empty" style="margin:4px 0 6px">' + ICON.empty + "<h2>Nobody logged yet</h2><p>Results for this session haven\u2019t been entered. Check back soon.</p></div></section>";
    }

    h += "<ol>";
    r.logged.forEach(function (x, i) { h += rowHTML(x, i); });
    h += "</ol>";
    if (r.absent.length) {
      h += '<p class="absent">' + (sel === "all" ? "No results yet: " : "Not logged this session: ") +
        r.absent.map(function (p) { return esc(p.name); }).join(", ") + "</p>";
    }
    return h + "</section>";
  }

  function lineHTML(l, extra) {
    var met = l.goal > 0 && l.value >= l.goal;
    return '<span class="' + (met ? "hit " : "") + (extra ? "extra" : "") + '"><i class="dot" style="background:' + D.metricColor(m, l.metricId) + '"></i>' +
      '<span><b class="num">' + l.value + "</b>" + (l.goal ? '<span class="num">/' + l.goal + "</span>" : "") +
      '<span class="lbl"> ' + esc(D.metricName(m, l.metricId)) + "</span></span>" +
      (met ? '<span class="up" aria-label="goal met">\u25B2</span>' : "") + "</span>";
  }

  function rowHTML(x, i) {
    var s = x.s, hit = s.pct != null && s.pct >= 100;
    var w = s.pct == null ? 0 : Math.min(s.pct, 100);
    var badges = "";
    if (hit) badges += '<span class="badge win hide-sm">' + ICON.check + "Goal hit</span>";
    var st = D.streak(m, x.p.id, sel === "all" ? null : sel);
    if (st >= 2) badges += '<span class="badge flame">' + ICON.flame + st + " in a row</span>";
    var extraCount = Math.max(0, s.lines.length - 3);
    return '<li><button class="row r' + (i + 1) + '" data-open="' + x.p.id + '">' +
      '<span class="rk num">' + (i + 1) + "</span>" + D.avatar(x.p) +
      '<span class="who"><span class="nm-line"><span class="nm">' + esc(x.p.name) + "</span>" + badges + "</span>" +
      '<span class="sub">' + s.lines.map(function (l, j) { return lineHTML(l, j >= 3); }).join("") +
      (extraCount ? '<span class="more-sm">+' + extraCount + " more</span>" : "") + "</span></span>" +
      '<span class="sc' + (s.pct == null ? " none" : hit ? " hit" : "") + '"><small>Score</small><b class="num">' + (s.pct == null ? "No goals" : s.pct + "%") + "</b></span>" +
      '<span class="prog" aria-hidden="true"><i class="' + (hit ? "hit" : "") + '" style="width:' + w + "%;animation-delay:" + (i * 60) + 'ms"></i></span>' +
      "</button></li>";
  }

  function sideHTML(r) {
    var totals = D.teamTotals(m, r.logged);
    var pct = D.pctOf(totals);
    var hitCount = r.logged.filter(function (x) { return x.s.pct != null && x.s.pct >= 100; }).length;
    var total = r.logged.length + r.absent.length;
    var C = 2 * Math.PI * 34, fill = pct == null ? 0 : Math.min(pct, 100) / 100;

    var note = sel === "all"
      ? "Totals across " + m.desc.length + " " + (m.desc.length === 1 ? "session" : "sessions") + ", against everyone\u2019s goals for the sessions they attended."
      : r.logged.length + " of " + total + " " + (total === 1 ? "person" : "people") + " logged for " + D.fmtDate(sessionById(sel).date, true) + ".";

    var h = '<div class="side-inner"><div class="side-head">' + ICON.trophy + "<div><small>" + esc(selLabel(false)) + "</small><h2>Team goal</h2></div></div>" +
      '<p class="side-note">' + esc(note) + "</p>";

    h += '<div class="big"><div class="ring"><svg viewBox="0 0 80 80" aria-hidden="true"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B9C0FF"/><stop offset="1" stop-color="#5F6CE3"/></linearGradient></defs>' +
      '<circle cx="40" cy="40" r="34" fill="none" stroke="rgba(150,165,255,.14)" stroke-width="8"/>' +
      '<circle cx="40" cy="40" r="34" fill="none" stroke="' + (pct >= 100 ? "#56DDA6" : "url(#rg)") + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' +
      (C * fill).toFixed(1) + " " + C.toFixed(1) + '"/></svg><b class="num">' + (pct == null ? "\u2013" : pct + "%") + "</b></div>" +
      "<p><strong>" + (r.logged.length ? hitCount + " of " + r.logged.length + " hit their goal" : "No results yet") + "</strong>" +
      (pct == null ? "Set goals in admin to track progress." : pct >= 100 ? "The team is ahead of target." : "Combined progress towards the team\u2019s goals.") + "</p></div>";

    // Show metrics shared by two or more people first; fall back to whatever was logged.
    var shared = totals.filter(function (t) { return t.people.length >= 2; });
    var tiles = (shared.length ? shared : totals).slice(0, 4);
    if (tiles.length) {
      h += '<ul class="pills">' + tiles.map(function (t) {
        return '<li class="prow fill"><span class="pk"><i class="dot" style="background:' + D.metricColor(m, t.metricId) + '"></i><span class="pn-t">' +
          esc(D.metricName(m, t.metricId)) + '</span></span><span class="pv num">' + t.value + (t.goal ? " <small>/ " + t.goal + "</small>" : "") + "</span></li>";
      }).join("") + "</ul>";
    }

    if (r.logged.length) {
      var items = [];
      shared.slice(0, 3).forEach(function (t) {
        var best = Math.max.apply(null, t.people.map(function (x) { return x.value; }));
        var who = t.people.filter(function (x) { return x.value === best; });
        if (best > 0 && who.length === 1) items.push({ label: "Most " + softLower(D.metricName(m, t.metricId)), value: String(best), p: who[0].p });
      });
      var streakTop = null, streakN = 1;
      r.logged.forEach(function (x) {
        var n = D.streak(m, x.p.id, sel === "all" ? null : sel);
        if (n > streakN) { streakN = n; streakTop = x.p; }
      });
      if (streakTop) items.push({ label: "Best goal streak", value: streakN + " in a row", p: streakTop });
      if (items.length) {
        h += '<div class="side-sec">Highlights</div><ul class="pills">' + items.map(function (it) {
          return '<li><button class="prow hlrow" data-open="' + it.p.id + '">' + D.avatar(it.p, "sm") +
            '<span class="hl-who"><b>' + esc(firstName(it.p)) + "</b><small>" + esc(it.label) + "</small></span>" +
            '<span class="hl-v num">' + esc(it.value) + "</span></button></li>";
        }).join("") + "</ul>";
      }
    }
    return h + "</div>";
  }

  // ---------- detail sheet ----------
  var lastFocus = null;
  function openSheet(id) {
    lastFocus = document.activeElement;
    openId = id;
    renderSheet(true);
  }
  function closeSheet() {
    var root = $("sheetRoot");
    document.body.classList.remove("sheet-open");
    openId = null;
    setTimeout(function () { if (!openId) root.innerHTML = ""; }, 320);
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function renderSheet(fresh) {
    var p = m.byId[openId];
    if (!p) { closeSheet(); return; }
    var s = D.score(m, p.id, sel);
    var hist = D.history(m, p.id, null);
    var hit = s && s.pct != null && s.pct >= 100;

    var h = '<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shName" tabindex="-1">' +
      '<div class="grab"></div><div class="sh-head">' + D.avatar(p) + '<div><h2 id="shName">' + esc(p.name) + "</h2><p>" + esc(selLabel(true)) + "</p></div>" +
      '<button class="close" data-close aria-label="Close">' + ICON.close + "</button></div>";

    if (!s) {
      h += '<p style="color:var(--muted);margin:22px 0">No results logged for ' + (sel === "all" ? "any session" : "this session") + ".</p>";
    } else {
      h += '<div class="sh-score' + (hit ? " hit" : "") + '"><strong class="num">' + (s.pct == null ? "\u2013" : s.pct + "%") +
        "</strong><span>" + (s.pct == null ? "no goals set" : "of goal") + "</span></div>";
      h += s.lines.map(function (l) {
        var w = l.goal ? Math.min(l.value / l.goal, 1) * 100 : 0, col = D.metricColor(m, l.metricId);
        return '<div class="mrow"><span class="l"><i class="dot" style="background:' + col + '"></i><span class="pn-t">' + esc(D.metricName(m, l.metricId)) +
          '</span></span><span class="b"><i style="width:' + w.toFixed(1) + "%;background:" + col + '"></i></span><span class="v"><b>' + l.value + "</b>" +
          (l.goal ? " <small>/ " + l.goal + "</small>" : "") + "</span></div>";
      }).join("");
    }

    if (hist.length) {
      var best = hist.reduce(function (b, x) { return x.pct != null && (b == null || x.pct > b) ? x.pct : b; }, null);
      var hits = hist.filter(function (x) { return x.pct != null && x.pct >= 100; }).length;
      h += '<div class="hl">' +
        "<div><strong>" + D.streak(m, p.id, null) + "</strong><span>Goal streak</span></div>" +
        "<div><strong>" + (best == null ? "\u2013" : best + "%") + "</strong><span>Best session</span></div>" +
        "<div><strong>" + hist.length + "</strong><span>Sessions</span></div>" +
        "<div><strong>" + hits + "</strong><span>Goals hit</span></div></div>";

      h += '<h3 class="sh-sec">Score by session</h3>' + sparkHTML(hist.slice(-12));

      var cols = [];
      hist.forEach(function (x) { x.score.lines.forEach(function (l) { if (cols.indexOf(l.metricId) < 0) cols.push(l.metricId); }); });
      cols.sort(function (a, b) { return (m.metricOrder[a] || 0) - (m.metricOrder[b] || 0); });
      h += '<h3 class="sh-sec">History</h3><div class="hist"><table><thead><tr><th>Session</th>' +
        cols.map(function (c) { return "<th>" + esc(D.metricName(m, c)) + "</th>"; }).join("") + "<th>Score</th></tr></thead><tbody>";
      hist.slice().reverse().forEach(function (x) {
        var e = D.entry(m, x.session.id, p.id);
        h += "<tr><td>" + esc(D.fmtDate(x.session.date)) + "</td>" + cols.map(function (c) {
          var l = e[c];
          if (!l) return '<td><small>\u2013</small></td>';
          return '<td class="' + (l.goal && l.value >= l.goal ? "hit" : "") + '">' + l.value + (l.goal ? " <small>/ " + l.goal + "</small>" : "") + "</td>";
        }).join("") + '<td class="' + (x.pct >= 100 ? "hit" : "") + '">' + (x.pct == null ? "\u2013" : x.pct + "%") + "</td></tr>";
      });
      h += "</tbody></table></div>";
    }
    h += "</div>";

    var root = $("sheetRoot");
    var old = root.querySelector(".sheet"), scroll = old ? old.scrollTop : 0;
    root.innerHTML = h;
    var sheet = root.querySelector(".sheet");
    if (fresh) {
      document.body.style.overflow = "hidden";
      sheet.getBoundingClientRect();
      requestAnimationFrame(function () {
        document.body.classList.add("sheet-open");
        sheet.focus({ preventScroll: true });
      });
    } else {
      sheet.scrollTop = scroll;
    }
  }

  function sparkHTML(pts) {
    if (pts.length < 2) return '<p style="color:var(--muted);font-size:.875rem;margin:0">The trend appears after two sessions.</p>';
    var W = 320, H = 120, pad = 14;
    var vals = pts.map(function (x) { return x.pct == null ? 0 : x.pct; });
    var top = Math.max(150, Math.max.apply(null, vals) + 10);
    var X = function (i) { return pad + i * (W - pad * 2) / (pts.length - 1); };
    var Y = function (v) { return H - pad - v / top * (H - pad * 2); };
    var line = vals.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ");
    var area = line + " L" + X(vals.length - 1).toFixed(1) + " " + (H - pad) + " L" + X(0).toFixed(1) + " " + (H - pad) + " Z";
    var dots = vals.map(function (v, i) {
      return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="' + (i === vals.length - 1 ? 5 : 3.2) + '" fill="' +
        (v >= 100 ? "#56DDA6" : "#8E9AFF") + '" stroke="#131B36" stroke-width="2"><title>' +
        esc(D.fmtDate(pts[i].session.date)) + ": " + v + "%</title></circle>";
    }).join("");
    return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Score by session, latest ' + vals[vals.length - 1] + '%">' +
      '<defs><linearGradient id="sa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(142,154,255,.35)"/><stop offset="1" stop-color="rgba(142,154,255,0)"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#sa)"/>' +
      '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + Y(100).toFixed(1) + '" y2="' + Y(100).toFixed(1) + '" stroke="#56DDA6" stroke-width="1.2" stroke-dasharray="4 4" opacity=".8"/>' +
      '<text x="' + pad + '" y="' + (Y(100) - 5).toFixed(1) + '" font-size="10" fill="#56DDA6" font-family="Figtree, sans-serif">Goal</text>' +
      '<path d="' + line + '" fill="none" stroke="#8E9AFF" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + "</svg>";
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-mode],[data-open],[data-close]");
    if (!t) return;
    if (t.hasAttribute("data-mode")) {
      var mode = t.getAttribute("data-mode");
      if (mode === "all") setSel("all");
      else if (sel === "all") setSel(m.desc[0].id);
    } else if (t.hasAttribute("data-open")) openSheet(t.getAttribute("data-open"));
    else closeSheet();
  });
  document.addEventListener("change", function (e) { if (e.target.id === "pick") setSel(e.target.value); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && openId) closeSheet(); });
  window.addEventListener("hashchange", function () { if (m) render(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });

  load();
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(updateLive, 20000);
})();
