(function () {
  "use strict";
  var D = window.DH, esc = D.esc;
  var TOKEN_KEY = "devhour-admin-token";
  var root = document.getElementById("root");

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  var data = null, m = null, cur = null, pins = {};
  var TEAM_KEY = "devhour-admin-team";
  var teamSlug = new URLSearchParams(location.search).get("team") || "";
  if (!teamSlug) { try { teamSlug = localStorage.getItem(TEAM_KEY) || ""; } catch (e) {} }
  var waiting = {}, inflight = [], pending = 0, errored = false;

  var ICON = {
    mark: '<svg viewBox="0 0 20 20"><rect x="2" y="11" width="4" height="7" rx="1.6" fill="#fff"/><rect x="8" y="7" width="4" height="11" rx="1.6" fill="#fff"/><rect x="14" y="2" width="4" height="16" rx="1.6" fill="#fff"/></svg>',
    archive: '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 5.5h14M4.5 5.5v10a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-10M8 9.5h4M4 3h12"/></svg>',
    trash: '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3.5 5.5h13M8 5.5V3.5h4v2M5 5.5l.8 11h8.4l.8-11"/></svg>',
    x: '<svg viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m5.5 5.5 9 9m0-9-9 9"/></svg>'
  };

  function call(path, method, body) {
    return D.api(path, { method: method, body: body, token: token }).catch(function (err) {
      if (err.status === 401) signOut("Your session ended. Sign in again.");
      throw err;
    });
  }

  // ---------- save status ----------
  var statusTimer;
  function setStatus() {
    var el = document.getElementById("status"), txt = el.lastChild;
    clearTimeout(statusTimer);
    if (pending > 0) { el.className = "status saving"; txt.textContent = "Saving\u2026"; }
    else if (errored) { el.className = "status error"; txt.textContent = errored === true ? "Couldn\u2019t save. Check your connection and edit again." : errored; }
    else {
      el.className = "status"; txt.textContent = "All changes saved";
      statusTimer = setTimeout(function () { el.className = "status idle"; }, 2200);
    }
  }
  function track(promise) {
    pending++; errored = false; setStatus();
    var settled = promise.catch(function () {});
    inflight.push(settled);
    settled.then(function () { inflight = inflight.filter(function (x) { return x !== settled; }); });
    return promise.then(function (r) { pending--; setStatus(); return r; }, function (err) {
      pending--; errored = err && err.status === 400 ? err.message : true; setStatus(); throw err;
    });
  }
  // Debounced saves, keyed so repeated edits to one field send one request.
  function debounce(key, fn, ms) {
    if (waiting[key]) clearTimeout(waiting[key].t);
    var w = { fn: fn };
    w.t = setTimeout(function () { delete waiting[key]; fn(); }, ms || 600);
    waiting[key] = w;
  }
  function flush() {
    Object.keys(waiting).forEach(function (k) {
      var w = waiting[k]; clearTimeout(w.t); delete waiting[k]; w.fn();
    });
  }
  window.addEventListener("beforeunload", function (e) {
    if (pending > 0 || Object.keys(waiting).length) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------- auth ----------
  function signOut(msg) {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    renderLogin(msg);
  }

  function renderLogin(msg) {
    root.innerHTML = '<div class="login"><form id="loginForm">' +
      '<span class="mark admin" aria-hidden="true">' + ICON.mark + "</span>" +
      "<h1>Admin sign in</h1><p>Set metrics, goals and results for the development hour.</p>" +
      '<label for="pw">Password</label><input class="field" id="pw" type="password" autocomplete="current-password" autocapitalize="off" required>' +
      '<button class="btn primary" type="submit">Sign in</button><p class="err" id="loginErr" role="alert">' + esc(msg || "") + "</p></form></div>";
    var f = document.getElementById("loginForm");
    document.getElementById("pw").focus();
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = f.querySelector("button");
      btn.disabled = true; btn.textContent = "Signing in\u2026";
      D.api("/api/login", { method: "POST", body: { password: document.getElementById("pw").value } }).then(function (r) {
        token = r.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) {}
        start();
      }, function (err) {
        btn.disabled = false; btn.textContent = "Sign in";
        document.getElementById("loginErr").textContent = err.message;
      });
    });
  }

  // ---------- data ----------
  function reload() {
    flush();
    return Promise.all(inflight).then(function () {
      return D.api("/api/data", { query: { team: teamSlug } }).catch(function (err) {
        if (err.status !== 404 || !teamSlug) throw err;
        teamSlug = ""; // saved team no longer exists: fall back to the first team
        return D.api("/api/data");
      });
    }).then(function (d) {
      return D.api("/api/admin/pins", { token: token, query: { team: d.team.slug } })
        .then(function (p) { pins = p; return d; }, function () { pins = {}; return d; });
    }).then(function (d) {
      if (data && data.team.id !== d.team.id) cur = null;
      data = d; m = D.model(d);
      teamSlug = d.team.slug;
      try { localStorage.setItem(TEAM_KEY, teamSlug); } catch (e) {}
      var q = d.teams.length && d.teams[0].id === d.team.id ? "" : "?team=" + encodeURIComponent(teamSlug);
      if (location.search !== q) history.replaceState(null, "", location.pathname + q);
      if (!cur || !m.desc.some(function (s) { return s.id === cur; })) cur = m.desc.length ? m.desc[0].id : null;
      render();
    });
  }

  function start() {
    root.innerHTML = '<div class="wrap"><p style="color:var(--muted)">Loading\u2026</p></div>';
    call("/api/admin/check", "GET").then(reload).catch(function (err) {
      if (err.status !== 401) root.innerHTML = '<div class="wrap"><div class="panel"><h2>Can\u2019t reach the server</h2><p class="hint">' + esc(err.message) + '</p><button class="btn" data-act="retry">Try again</button></div></div>';
    });
  }

  // ---------- helpers ----------
  function boardLink(absolute) {
    var first = data.teams.length && data.teams[0].id === data.team.id;
    return (absolute ? location.origin : "") + "/" + (first ? "" : "?team=" + encodeURIComponent(data.team.slug));
  }
  function dot(id) { return '<i class="dot" style="background:' + D.metricColor(m, id) + '"></i>'; }
  function numInput(attrs, value, label, placeholder) {
    return '<input class="field" type="number" inputmode="numeric" min="0" step="1" ' + attrs + ' aria-label="' + esc(label) + '" value="' +
      (value == null ? "" : value) + '"' + (placeholder != null ? ' placeholder="' + esc(placeholder) + '"' : "") + ">";
  }
  function assignedGoal(p, mid) {
    for (var i = 0; i < p.metrics.length; i++) if (p.metrics[i].metricId === mid) return p.metrics[i].goal;
    return null;
  }
  // Metrics shown for a person in a session: their current ones, plus any they logged before a metric was removed.
  function sessionMetrics(p, sid) {
    var ids = p.metrics.map(function (x) { return x.metricId; });
    var e = D.entry(m, sid, p.id) || {};
    Object.keys(e).forEach(function (k) { if (ids.indexOf(k) < 0) ids.push(k); });
    return ids;
  }
  function scoreText(pid) {
    var s = D.score(m, pid, cur);
    return !s ? "\u2013" : s.pct == null ? "n/a" : s.pct + "%";
  }
  function scoreClass(pid) {
    var s = D.score(m, pid, cur);
    return "pct" + (s && s.pct >= 100 ? " hit" : s ? " some" : "");
  }

  // ---------- render ----------
  function render() {
    var focus = document.activeElement && document.activeElement.id;
    document.title = data.title + " admin";
    var h = '<div class="wrap"><header class="topbar"><div class="brand"><span class="mark admin" aria-hidden="true">' + ICON.mark +
      '</span><h1>' + esc(data.title) + ' <span class="tag">Admin</span></h1></div><div class="actions">' +
      '<a class="btn" href="' + boardLink(false) + '" target="_blank" rel="noopener">Leaderboard</a>' +
      '<button class="btn quiet" data-act="signout">Sign out</button></div></header>';
    if (data.teams.length > 1) {
      h += '<nav class="teamtabs" aria-label="Teams">' + data.teams.map(function (t) {
        return '<button data-act="team" data-slug="' + esc(t.slug) + '"' + (t.id === data.team.id ? ' aria-current="page"' : "") + ">" + esc(t.name) + "</button>";
      }).join("") + "</nav>";
    }
    h += resultsPanel() + metricsPanel() + teamPanel() + settingsPanel() + "</div>";
    root.innerHTML = h;
    if (focus) { var el = document.getElementById(focus); if (el) el.focus(); }
  }

  function resultsPanel() {
    var h = '<section class="panel"><h2>Log results</h2><p class="hint">Numbers save as you type. Once someone has any number in, blank boxes count as 0. Clear all their boxes to take them out of the session. Metrics with no goal aren\u2019t shown on the leaderboard.</p>';
    h += '<div class="bar">';
    if (m.desc.length) {
      h += '<label for="sessionSel" class="sr">Session</label><select class="field grow" id="sessionSel">' + m.desc.map(function (s) {
        return '<option value="' + s.id + '"' + (s.id === cur ? " selected" : "") + ">" + esc(D.fmtDate(s.date, true)) + "</option>";
      }).join("") + "</select>";
    }
    h += '<button class="btn primary" data-act="new-session">New session</button></div>';

    if (!cur) return h + '<div class="empty-note">Create your first session to start logging results.</div></section>';
    var s = m.desc.filter(function (x) { return x.id === cur; })[0];
    h += '<div class="bar"><label>Date <input class="field" type="date" id="sessionDate" value="' + esc(s.date) + '"></label>' +
      '<button class="btn quiet" data-act="refresh-goals" title="Apply everyone\u2019s current goals to this session">Use current goals</button>' +
      '<button class="btn quiet danger" data-act="del-session">Delete session</button></div>';
    h += photoBox(s);

    var people = m.people.filter(function (p) { return (p.active && p.metrics.length) || D.entry(m, cur, p.id); });
    if (!people.length) {
      return h + '<div class="empty-note">' + (m.metrics.length ? "Give people metrics in Team below, then log their numbers here." : "Create your metrics below, then give them to your team.") + "</div></section>";
    }

    h += '<div class="cards">';
    people.forEach(function (p) {
      var e = D.entry(m, cur, p.id) || {};
      h += '<div class="card' + (p.active ? "" : " dim") + '"><div class="card-head">' + D.avatar(p) + '<span class="cn">' + esc(p.name) + "</span>" +
        '<span class="' + scoreClass(p.id) + '" id="pct-' + p.id + '">' + scoreText(p.id) + "</span></div>";
      sessionMetrics(p, cur).forEach(function (mid) {
        var val = e[mid] ? e[mid].value : null;
        var goal = e[mid] ? e[mid].goal : assignedGoal(p, mid);
        h += '<label class="line"><span class="ln">' + dot(mid) + '<span class="pn-t">' + esc(D.metricName(m, mid)) + "</span></span>" +
          '<span class="lg"' + (goal ? ">/ " + goal : ' title="Set a goal in Team to show this on the leaderboard">no goal') + "</span>" +
          numInput('id="e-' + p.id + "-" + mid + '" data-entry="' + p.id + '" data-metric="' + mid + '"', val, p.name + " " + D.metricName(m, mid)) + "</label>";
      });
      h += "</div>";
    });
    return h + "</div></section>";
  }

  function photoBox(s) {
    var w = D.winners(m, s.id), url = D.photoUrl(s);
    return '<div class="photobox"><div class="pb-media">' + (url ? '<img src="' + esc(url) + '" alt="Session photo">' : '<span>No photo yet</span>') + "</div>" +
      '<div class="pb-body"><div class="pb-win">' + (w ? "Winner: <b>" + esc(w.people.map(function (p) { return p.name; }).join(" & ")) + "</b> " + w.pct + "%" : "No winner yet") + "</div>" +
      '<input class="field" type="text" maxlength="140" id="capIn" placeholder="Caption for the Winners page (optional)" aria-label="Photo caption" value="' + esc(s.caption || "") + '">' +
      '<div class="bar" style="margin:0"><button class="btn" data-act="admin-photo">' + (url ? "Replace photo" : "Add photo") + "</button>" +
      (url ? '<button class="btn quiet danger" data-act="del-photo">Remove photo</button>' : "") + "</div>" +
      '<p class="hint" style="margin:0">The session\u2019s winner can also add this from the Winners page with their PIN.</p></div>' +
      '<input type="file" id="adminPhoto" accept="image/*" hidden></div>';
  }

  function metricsPanel() {
    var h = '<section class="panel"><h2>Metrics</h2><p class="hint">This team\u2019s list of things to track. The default goal is used when you give a metric to someone new.</p>';
    if (m.metrics.length) {
      h += '<div class="mlist">';
      m.metrics.forEach(function (x) {
        var users = m.people.filter(function (p) { return p.active && assignedGoal(p, x.id) !== null; }).length;
        h += '<div class="mitem">' + dot(x.id) +
          '<input class="field" type="text" maxlength="40" id="mn-' + x.id + '" data-mname="' + x.id + '" aria-label="Metric name" value="' + esc(x.name) + '">' +
          '<span class="mcount">' + users + (users === 1 ? " person" : " people") + "</span>" +
          '<label class="mdef"><span>Goal</span>' + numInput('id="md-' + x.id + '" data-mdef="' + x.id + '"', x.defaultGoal || 0, x.name + " default goal") + "</label>" +
          '<button class="iconbtn" data-act="del-metric" data-id="' + x.id + '" aria-label="Delete ' + esc(x.name) + '" title="Delete">' + ICON.trash + "</button></div>";
      });
      h += "</div>";
    } else {
      h += '<div class="empty-note">No metrics yet. Add your first one below, e.g. \u201cCold calls\u201d or \u201cProposals sent\u201d.</div>';
    }
    h += '<form class="addrow" id="metricForm"><div class="bar" style="margin:0">' +
      '<input class="field grow" type="text" maxlength="40" id="newMetric" placeholder="New metric name" aria-label="New metric name" required>' +
      '<input class="field goalin" type="number" inputmode="numeric" min="0" step="1" id="newMetricGoal" placeholder="Goal" aria-label="Default goal">' +
      '<label class="chk"><input type="checkbox" id="newMetricAll" checked> Give to everyone now</label>' +
      '<button class="btn" type="submit">Add metric</button></div></form>';
    return h + "</section>";
  }

  function teamPanel() {
    var active = m.people.filter(function (p) { return p.active; });
    var archived = m.people.filter(function (p) { return !p.active; });
    var h = '<section class="panel"><h2>Team</h2><p class="hint">Each person can have their own metrics and goals. Give each person their PIN so they can log their own numbers by tapping their name on the leaderboard.</p>';
    if (active.length) {
      h += '<div class="cards">';
      active.forEach(function (p) {
        h += '<div class="card"><div class="card-head">' + D.avatar(p) +
          '<input class="field cname" type="text" maxlength="60" id="n-' + p.id + '" data-name="' + p.id + '" aria-label="Name" value="' + esc(p.name) + '">' +
          '<button class="iconbtn" data-act="archive" data-id="' + p.id + '" aria-label="Archive ' + esc(p.name) + '" title="Archive">' + ICON.archive + "</button></div>" +
          '<div class="pinline"><span>PIN <b class="num" id="pin-' + p.id + '">' + esc(pins[p.id] || "\u2013") + "</b></span>" +
          '<button class="btn quiet" data-act="new-pin" data-id="' + p.id + '">New PIN</button></div>';
        if (!p.metrics.length) h += '<p class="hint" style="margin:4px 0 8px">No metrics yet.</p>';
        p.metrics.forEach(function (a) {
          h += '<div class="line tl"><span class="ln">' + dot(a.metricId) + '<span class="pn-t">' + esc(D.metricName(m, a.metricId)) + '</span></span><span class="lg">Goal</span>' +
            numInput('id="g-' + p.id + "-" + a.metricId + '" data-goal="' + p.id + '" data-metric="' + a.metricId + '"', a.goal, p.name + " " + D.metricName(m, a.metricId) + " goal") +
            '<button class="iconbtn sm" data-act="unassign" data-id="' + p.id + '" data-metric="' + a.metricId + '" aria-label="Remove ' + esc(D.metricName(m, a.metricId)) + " from " + esc(p.name) + '">' + ICON.x + "</button></div>";
        });
        var free = m.metrics.filter(function (x) { return assignedGoal(p, x.id) === null; });
        if (free.length) {
          h += '<div class="assign"><select class="field" id="as-' + p.id + '" aria-label="Metric to add"><option value="">Add a metric\u2026</option>' +
            free.map(function (x) { return '<option value="' + x.id + '" data-def="' + (x.defaultGoal || 0) + '">' + esc(x.name) + "</option>"; }).join("") + "</select>" +
            '<input class="field goalin" type="number" inputmode="numeric" min="0" step="1" id="ag-' + p.id + '" placeholder="Goal" aria-label="Goal">' +
            '<button class="btn" data-act="assign" data-id="' + p.id + '">Add</button></div>';
        }
        h += "</div>";
      });
      h += "</div>";
    } else {
      h += '<div class="empty-note">No one on the team yet. Add your first person below.</div>';
    }

    h += '<form class="addrow" id="addForm"><div class="bar" style="margin:0">' +
      '<input class="field grow" type="text" maxlength="60" id="newName" placeholder="New person\u2019s name" aria-label="New person\u2019s name" required>';
    if (m.metrics.length) {
      h += '<select class="field" id="copyFrom" aria-label="Starting metrics"><option value="all">All ' + m.metrics.length + " metrics (default goals)</option>" +
        active.filter(function (p) { return p.metrics.length; }).map(function (p) {
          return '<option value="' + p.id + '">Same as ' + esc(p.name) + "</option>";
        }).join("") + '<option value="">No metrics yet</option></select>';
    }
    h += '<button class="btn" type="submit">Add person</button></div></form>';

    if (archived.length) {
      h += '<details class="archived"><summary>Archived (' + archived.length + ")</summary>";
      archived.forEach(function (p) {
        h += '<div class="arch-row"><div class="who">' + D.avatar(p) + "<span>" + esc(p.name) + "</span></div>" +
          '<button class="btn quiet" data-act="restore" data-id="' + p.id + '">Restore</button>' +
          '<button class="btn quiet danger" data-act="delete-person" data-id="' + p.id + '">Delete</button></div>';
      });
      h += '<p class="hint" style="margin-top:10px">Archived people keep their past results on the leaderboard. Deleting removes them and their results for good.</p></details>';
    }
    return h + "</section>";
  }

  function settingsPanel() {
    return '<section class="panel"><h2>' + esc(data.team.name) + ' settings</h2><p class="hint">Each team has its own leaderboard link. People can still switch sessions on the board; this sets what it opens on.</p>' +
      '<div class="setrow"><label for="teamName">Team name</label><input class="field" type="text" maxlength="40" id="teamName" value="' + esc(data.team.name) + '"></div>' +
      '<div class="setrow"><label for="teamDisplay">Board opens on</label><select class="field" id="teamDisplay">' +
      '<option value="latest"' + (!data.team.display ? " selected" : "") + ">Latest session (automatic)</option>" +
      '<option value="all"' + (data.team.display === "all" ? " selected" : "") + ">All time</option>" +
      m.desc.map(function (x) {
        return '<option value="' + x.id + '"' + (data.team.display === x.id ? " selected" : "") + ">" + esc(D.fmtDate(x.date, true)) + "</option>";
      }).join("") + "</select></div>" +
      '<div class="setrow"><label for="teamLink">Leaderboard link</label><div class="linkrow"><input class="field" type="text" id="teamLink" readonly value="' + esc(boardLink(true)) + '">' +
      '<button class="btn" data-act="copy-link">Copy</button></div></div>' +
      '</section>' +
      '<section class="panel"><h2>All teams</h2><p class="hint">The title shows at the top of every team\u2019s leaderboard.</p>' +
      '<div class="setrow"><label for="title">Title</label><input class="field" type="text" maxlength="80" id="title" value="' + esc(data.title) + '"></div>' +
      '<form class="addrow" id="teamForm"><div class="bar" style="margin:0">' +
      '<input class="field grow" type="text" maxlength="40" id="newTeam" placeholder="New team name" aria-label="New team name" required>' +
      '<button class="btn" type="submit">Add team</button></div></form></section>';
  }

  // ---------- local updates ----------
  function readInt(v) {
    v = String(v).trim();
    return v === "" ? null : Math.max(0, Math.floor(Number(v)) || 0);
  }
  function localEntries(pid) {
    var values = {};
    var inputs = root.querySelectorAll('[data-entry="' + pid + '"]');
    Array.prototype.forEach.call(inputs, function (inp) { values[inp.getAttribute("data-metric")] = readInt(inp.value); });
    var p = m.byId[pid];
    // Mirror the server: blanks count as 0 once anything is logged; all blank removes the person from the session.
    var allBlank = Object.keys(values).every(function (k) { return values[k] === null; });
    data.entries = data.entries.filter(function (e) {
      return !(e.sessionId === cur && e.personId === pid && (allBlank || values[e.metricId] === null));
    });
    if (!allBlank) p.metrics.forEach(function (a) {
      if (a.goal > 0 && values[a.metricId] === null) data.entries.push({ sessionId: cur, personId: pid, metricId: a.metricId, value: 0, goal: a.goal });
    });
    Object.keys(values).forEach(function (mid) {
      if (values[mid] === null) return;
      var e = data.entries.filter(function (x) { return x.sessionId === cur && x.personId === pid && x.metricId === mid; })[0];
      if (e) e.value = values[mid];
      else data.entries.push({ sessionId: cur, personId: pid, metricId: mid, value: values[mid], goal: assignedGoal(p, mid) || 0 });
    });
    m = D.model(data);
    var el = document.getElementById("pct-" + pid);
    if (el) { el.textContent = scoreText(pid); el.className = scoreClass(pid); }
    return values;
  }

  // ---------- events ----------
  root.addEventListener("input", function (e) {
    var t = e.target, pid, mid;
    if (t.hasAttribute("data-entry")) {
      pid = t.getAttribute("data-entry");
      var sid = cur, values = localEntries(pid);
      debounce("e|" + sid + "|" + pid, function () {
        track(call("/api/admin/sessions/" + sid + "/entries/" + pid, "PUT", { values: values })).catch(function () {});
      });
    } else if (t.hasAttribute("data-goal")) {
      pid = t.getAttribute("data-goal"); mid = t.getAttribute("data-metric");
      var goal = readInt(t.value) || 0;
      m.byId[pid].metrics.forEach(function (a) { if (a.metricId === mid) a.goal = goal; });
      debounce("g|" + pid + "|" + mid, function () {
        track(call("/api/admin/people/" + pid + "/metrics/" + mid, "PUT", { goal: goal })).catch(function () {});
      });
    } else if (t.hasAttribute("data-mdef")) {
      mid = t.getAttribute("data-mdef");
      var dg = readInt(t.value) || 0;
      m.metricById[mid].defaultGoal = dg;
      debounce("md|" + mid, function () {
        track(call("/api/admin/metrics/" + mid, "PATCH", { defaultGoal: dg })).catch(function () {});
      });
    } else if (t.hasAttribute("data-name")) {
      pid = t.getAttribute("data-name");
      var name = t.value.trim();
      if (!name) return;
      m.byId[pid].name = name;
      debounce("n|" + pid, function () {
        track(call("/api/admin/people/" + pid, "PATCH", { name: name })).catch(function () {});
      }, 700);
    } else if (t.hasAttribute("data-mname")) {
      mid = t.getAttribute("data-mname");
      var mname = t.value.trim();
      if (!mname) return;
      m.metricById[mid].name = mname;
      debounce("m|" + mid, function () {
        track(call("/api/admin/metrics/" + mid, "PATCH", { name: mname })).catch(function () {});
      }, 700);
    } else if (t.id === "teamName") {
      var tname = t.value.trim();
      if (!tname) return;
      var tid = data.team.id;
      debounce("team|" + tid, function () {
        track(call("/api/admin/teams/" + tid, "PATCH", { name: tname })).catch(function () {});
      }, 700);
    } else if (t.id === "capIn") {
      var cap = t.value, csid = cur;
      debounce("cap|" + csid, function () {
        track(call("/api/admin/sessions/" + csid, "PATCH", { caption: cap })).then(function () {
          var ss = data.sessions.filter(function (x) { return x.id === csid; })[0]; if (ss) ss.caption = cap.trim() || null;
        }).catch(function () {});
      }, 700);
    } else if (t.id === "title") {
      var title = t.value;
      debounce("title", function () {
        track(call("/api/admin/settings", "PUT", { title: title })).then(function (r) {
          data.title = r.title; document.title = r.title + " admin";
          var h1 = root.querySelector(".brand h1"); if (h1) h1.firstChild.textContent = r.title + " ";
        }).catch(function () {});
      }, 700);
    }
  });

  root.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "sessionSel") { flush(); cur = t.value; render(); }
    else if (t.id === "adminPhoto" && t.files && t.files[0]) {
      var psid = cur;
      D.compressImage(t.files[0]).then(function (img) {
        return track(call("/api/admin/sessions/" + psid + "/photo", "PUT", { type: img.type, data: img.data }));
      }).then(reload).catch(function (err) { alert(err.message); });
    }
    else if (t.id === "sessionDate" && t.value) {
      track(call("/api/admin/sessions/" + cur, "PATCH", { date: t.value })).then(reload).catch(function () {});
    } else if (t.id === "teamName") {
      if (!t.value.trim()) t.value = data.team.name; else reload().catch(function () {});
    } else if (t.id === "teamDisplay") {
      var dv = t.value;
      track(call("/api/admin/teams/" + data.team.id, "PATCH", { display: dv })).then(function (r) { data.team.display = r.display; }).catch(function () {});
    } else if (t.hasAttribute("data-name") || t.hasAttribute("data-mname")) {
      // Names changed: refresh labels elsewhere once saved.
      if (!t.value.trim()) {
        t.value = t.hasAttribute("data-name") ? m.byId[t.getAttribute("data-name")].name : m.metricById[t.getAttribute("data-mname")].name;
      } else {
        reload().catch(function () {});
      }
    } else if (t.id && t.id.indexOf("as-") === 0) {
      var opt = t.options[t.selectedIndex], gi = document.getElementById("ag-" + t.id.slice(3));
      if (gi) gi.placeholder = opt && opt.value ? opt.getAttribute("data-def") : "Goal";
    }
  });

  root.addEventListener("submit", function (e) {
    var id = e.target.id;
    if (id === "addForm") {
      e.preventDefault();
      var name = document.getElementById("newName").value.trim();
      if (!name) return;
      var cf = document.getElementById("copyFrom");
      track(call("/api/admin/people", "POST", { teamId: data.team.id, name: name, copyFrom: cf && cf.value ? cf.value : null }))
        .then(reload).then(function () { var n = document.getElementById("newName"); if (n) n.focus(); })
        .catch(function (err) { alert(err.message); });
    } else if (id === "teamForm") {
      e.preventDefault();
      var tn = document.getElementById("newTeam").value.trim();
      if (!tn) return;
      track(call("/api/admin/teams", "POST", { name: tn }))
        .then(function (t) { teamSlug = t.slug; return reload(); })
        .then(function () { window.scrollTo(0, 0); })
        .catch(function (err) { alert(err.message); });
    } else if (id === "metricForm") {
      e.preventDefault();
      var mname = document.getElementById("newMetric").value.trim();
      if (!mname) return;
      var all = document.getElementById("newMetricAll").checked;
      var goal = readInt(document.getElementById("newMetricGoal").value) || 0;
      track(call("/api/admin/metrics", "POST", { teamId: data.team.id, name: mname, assignAll: all, goal: goal }))
        .then(reload).then(function () { var n = document.getElementById("newMetric"); if (n) n.focus(); })
        .catch(function (err) { alert(err.message); });
    }
  });

  root.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id"), p = id && m && m.byId[id];
    var mid = b.getAttribute("data-metric");
    if (act === "retry") start();
    else if (act === "admin-photo") { var fi = document.getElementById("adminPhoto"); fi.value = ""; fi.click(); }
    else if (act === "del-photo") {
      if (!confirm("Remove this session\u2019s photo?")) return;
      track(call("/api/admin/sessions/" + cur + "/photo", "DELETE")).then(reload).catch(function () {});
    }
    else if (act === "team") {
      var slug = b.getAttribute("data-slug");
      if (slug === teamSlug) return;
      flush();
      teamSlug = slug;
      reload().then(function () { window.scrollTo(0, 0); }).catch(function () {});
    } else if (act === "copy-link") {
      var link = document.getElementById("teamLink");
      var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(link.value).then(done, function () { link.select(); });
      else { link.select(); document.execCommand("copy"); done(); }
    }
    else if (act === "signout") signOut();
    else if (act === "new-session") {
      flush();
      track(call("/api/admin/sessions", "POST", { teamId: data.team.id, date: D.todayISO() })).then(function (s) { cur = s.id; return reload(); }).catch(function (err) { alert(err.message); });
    } else if (act === "del-session") {
      var s = m.desc.filter(function (x) { return x.id === cur; })[0];
      if (!confirm("Delete the " + D.fmtDate(s.date, true) + " session and all its results?")) return;
      track(call("/api/admin/sessions/" + cur, "DELETE")).then(function () { cur = null; return reload(); }).catch(function () {});
    } else if (act === "refresh-goals") {
      if (!confirm("Replace the goals stored for this session with everyone\u2019s current goals?")) return;
      flush();
      track(call("/api/admin/sessions/" + cur + "/refresh-goals", "POST")).then(reload).catch(function () {});
    } else if (act === "del-metric") {
      var x = m.metricById[id];
      if (!x || !confirm("Delete \u201c" + x.name + "\u201d? It\u2019s removed from everyone, along with every number logged for it.")) return;
      track(call("/api/admin/metrics/" + id, "DELETE")).then(reload).catch(function () {});
    } else if (act === "assign" && p) {
      var sel = document.getElementById("as-" + id);
      if (!sel || !sel.value) { sel && sel.focus(); return; }
      var gRaw = readInt(document.getElementById("ag-" + id).value);
      var g = gRaw === null ? Number(sel.options[sel.selectedIndex].getAttribute("data-def")) || 0 : gRaw;
      track(call("/api/admin/people/" + id + "/metrics/" + sel.value, "PUT", { goal: g })).then(reload).catch(function () {});
    } else if (act === "unassign" && p) {
      track(call("/api/admin/people/" + id + "/metrics/" + mid, "DELETE")).then(reload).catch(function () {});
    } else if (act === "new-pin" && p) {
      if (!confirm("Give " + p.name + " a new PIN? Their old PIN stops working and they\u2019ll need to enter the new one.")) return;
      track(call("/api/admin/people/" + id, "PATCH", { newPin: true })).then(function (r) {
        pins[id] = r.pin;
        var el = document.getElementById("pin-" + id); if (el) el.textContent = r.pin;
      }).catch(function () {});
    } else if (act === "archive" && p) {
      track(call("/api/admin/people/" + id, "PATCH", { active: false })).then(reload).catch(function () {});
    } else if (act === "restore" && p) {
      track(call("/api/admin/people/" + id, "PATCH", { active: true })).then(reload).catch(function () {});
    } else if (act === "delete-person" && p) {
      if (!confirm("Delete " + p.name + " and all their results? This can\u2019t be undone.")) return;
      track(call("/api/admin/people/" + id, "DELETE")).then(reload).catch(function () {});
    }
  });

  if (token) start(); else renderLogin();
})();
