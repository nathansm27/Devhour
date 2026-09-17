(function () {
  "use strict";
  var D = window.DH, esc = D.esc, M = D.METRICS;
  var TOKEN_KEY = "devhour-admin-token";
  var root = document.getElementById("root");

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  var data = null, m = null, cur = null;
  var waiting = {}, inflight = [], pending = 0, errored = false;

  var ICON = {
    mark: '<svg viewBox="0 0 20 20"><rect x="2" y="11" width="4" height="7" rx="1.6" fill="#fff"/><rect x="8" y="7" width="4" height="11" rx="1.6" fill="#fff"/><rect x="14" y="2" width="4" height="16" rx="1.6" fill="#fff"/></svg>',
    archive: '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 5.5h14M4.5 5.5v10a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-10M8 9.5h4M4 3h12"/></svg>'
  };

  function call(path, method, body) {
    return D.api(path, { method: method, body: body, token: token }).catch(function (err) {
      if (err.status === 401) signOut("Your session ended. Sign in again.");
      throw err;
    });
  }

  // ---------- status ----------
  var statusTimer;
  function setStatus() {
    var el = document.getElementById("status"), txt = el.lastChild;
    clearTimeout(statusTimer);
    if (pending > 0) { el.className = "status saving"; txt.textContent = "Saving\u2026"; }
    else if (errored) { el.className = "status error"; txt.textContent = "Couldn\u2019t save. Check your connection and edit again."; }
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
      pending--; errored = true; setStatus(); throw err;
    });
  }
  // Debounced saves, keyed so repeated edits to one field send one request.
  function debounce(key, fn, ms) {
    if (waiting[key]) clearTimeout(waiting[key].t);
    var w = { fn: fn };
    w.t = setTimeout(function () { delete waiting[key]; fn(); }, ms || 600);
    waiting[key] = w;
  }
  // Send any waiting saves now.
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
      "<h1>Admin sign in</h1><p>Set goals and log results for the development hour.</p>" +
      '<label for="pw">Password</label><input class="field" id="pw" type="password" autocomplete="current-password" required>' +
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
    return Promise.all(inflight).then(function () { return D.api("/api/data"); }).then(function (d) {
      data = d; m = D.model(d);
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

  // ---------- render ----------
  function render() {
    var focus = document.activeElement && document.activeElement.id;
    document.title = data.title + " admin";
    var h = '<div class="wrap"><header class="topbar"><div class="brand"><span class="mark admin" aria-hidden="true">' + ICON.mark +
      '</span><h1>' + esc(data.title) + ' <span class="tag">Admin</span></h1></div><div class="actions">' +
      '<a class="btn" href="/" target="_blank" rel="noopener">Leaderboard</a>' +
      '<button class="btn quiet" data-act="signout">Sign out</button></div></header>';
    h += resultsPanel() + teamPanel() + settingsPanel() + "</div>";
    root.innerHTML = h;
    if (focus) { var el = document.getElementById(focus); if (el) el.focus(); }
  }

  function resultsPanel() {
    var h = '<section class="panel"><h2>Log results</h2><p class="hint">Numbers save as you type. Leave a row blank if someone wasn\u2019t there.</p>';
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

    var people = m.people.filter(function (p) { return p.active || D.entry(m, cur, p.id); });
    if (!people.length) return h + '<div class="empty-note">Add people in Team and goals below, then log their results here.</div></section>';

    h += '<div class="table"><div class="th left">Person</div>' + M.map(function (k) {
      return '<div class="th"><i class="dot ' + k.key + '"></i>' + k.label + "</div>";
    }).join("") + '<div class="th">Score</div>';
    people.forEach(function (p) {
      var e = D.entry(m, cur, p.id) || {};
      h += '<div class="who' + (p.active ? "" : " dim") + '">' + D.avatar(p) + "<span>" + esc(p.name) + "</span></div>";
      M.forEach(function (k) {
        h += '<input class="field" type="number" inputmode="numeric" min="0" step="1" id="r-' + p.id + "-" + k.key +
          '" data-res="' + p.id + '" data-k="' + k.key + '" aria-label="' + esc(p.name + " " + k.label) + '" value="' + (e[k.key] == null ? "" : e[k.key]) + '">';
      });
      h += '<div class="' + pctClass(p.id) + '" id="pct-' + p.id + '">' + pctText(p.id) + "</div>";
    });
    return h + "</div></section>";
  }

  function pctText(pid) {
    var s = D.score(m, pid, cur);
    return !s ? "\u2013" : s.pct == null ? "n/a" : s.pct + "%";
  }
  function pctClass(pid) {
    var s = D.score(m, pid, cur);
    return "pct" + (s && s.pct >= 100 ? " hit" : s ? " some" : "");
  }

  function teamPanel() {
    var active = m.people.filter(function (p) { return p.active; });
    var archived = m.people.filter(function (p) { return !p.active; });
    var h = '<section class="panel"><h2>Team and goals</h2><p class="hint">Goals are per session. A session keeps the goals people had when their results were first logged.</p>';
    if (active.length) {
      h += '<div class="table goals"><div class="th left">Name</div>' + M.map(function (k) {
        return '<div class="th"><i class="dot ' + k.key + '"></i>' + k.label + "</div>";
      }).join("") + "<div></div>";
      active.forEach(function (p) {
        h += '<div class="who">' + D.avatar(p) + '<input class="field" type="text" maxlength="60" id="n-' + p.id + '" data-name="' + p.id +
          '" aria-label="Name" value="' + esc(p.name) + '"></div>';
        M.forEach(function (k) {
          h += '<input class="field" type="number" inputmode="numeric" min="0" step="1" id="g-' + p.id + "-" + k.key + '" data-goal="' + p.id +
            '" data-k="' + k.key + '" aria-label="' + esc(p.name + " " + k.label + " goal") + '" value="' + (p.goals[k.key] || 0) + '">';
        });
        h += '<button class="iconbtn" data-act="archive" data-id="' + p.id + '" aria-label="Archive ' + esc(p.name) + '" title="Archive">' + ICON.archive + "</button>";
      });
      h += "</div>";
    } else {
      h += '<div class="empty-note">No one on the team yet. Add your first person below.</div>';
    }

    h += '<form class="addrow" id="addForm"><div class="table goals">' +
      '<div class="who"><input class="field" type="text" maxlength="60" id="newName" placeholder="New person\u2019s name" aria-label="New person\u2019s name" required></div>' +
      M.map(function (k) {
        return '<input class="field" type="number" inputmode="numeric" min="0" step="1" id="newGoal-' + k.key + '" placeholder="0" aria-label="' + k.label + ' goal">';
      }).join("") + '<div></div></div><div class="bar" style="margin:10px 0 0"><button class="btn" type="submit">Add person</button></div></form>';

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
    return '<section class="panel"><h2>Settings</h2><p class="hint">The title shows at the top of the leaderboard.</p>' +
      '<input class="field" style="width:100%" type="text" maxlength="80" id="title" aria-label="Leaderboard title" value="' + esc(data.title) + '"></section>';
  }

  // ---------- local updates ----------
  function localResult(pid) {
    var vals = {};
    M.forEach(function (k) {
      var v = document.getElementById("r-" + pid + "-" + k.key).value.trim();
      vals[k.key] = v === "" ? null : Math.max(0, Math.floor(Number(v)) || 0);
    });
    var empty = M.every(function (k) { return vals[k.key] == null; });
    var idx = data.results.findIndex(function (r) { return r.sessionId === cur && r.personId === pid; });
    if (empty) { if (idx >= 0) data.results.splice(idx, 1); }
    else if (idx >= 0) M.forEach(function (k) { data.results[idx][k.key] = vals[k.key]; });
    else {
      var p = m.byId[pid];
      data.results.push(Object.assign({ sessionId: cur, personId: pid, goals: Object.assign({}, p.goals) }, vals));
    }
    m = D.model(data);
    var el = document.getElementById("pct-" + pid);
    if (el) { el.textContent = pctText(pid); el.className = pctClass(pid); }
    return vals;
  }

  // ---------- events ----------
  root.addEventListener("input", function (e) {
    var t = e.target, pid, k;
    if (t.hasAttribute("data-res")) {
      pid = t.getAttribute("data-res");
      var sid = cur, vals = localResult(pid);
      debounce("r|" + sid + "|" + pid, function () {
        track(call("/api/admin/sessions/" + sid + "/results/" + pid, "PUT", vals)).catch(function () {});
      });
    } else if (t.hasAttribute("data-goal")) {
      pid = t.getAttribute("data-goal"); k = t.getAttribute("data-k");
      var n = t.value.trim() === "" ? 0 : Math.max(0, Math.floor(Number(t.value)) || 0);
      m.byId[pid].goals[k] = n;
      debounce("g|" + pid + "|" + k, function () {
        var body = { goals: {} }; body.goals[k] = n;
        track(call("/api/admin/people/" + pid, "PATCH", body)).catch(function () {});
      });
    } else if (t.hasAttribute("data-name")) {
      pid = t.getAttribute("data-name");
      var name = t.value;
      if (!name.trim()) return;
      m.byId[pid].name = name.trim();
      debounce("n|" + pid, function () {
        track(call("/api/admin/people/" + pid, "PATCH", { name: name })).then(function () {
          // refresh names in the results table without stealing focus
          var who = root.querySelectorAll('[data-res="' + pid + '"]');
          if (who.length) {
            var span = who[0].previousElementSibling && who[0].previousElementSibling.querySelector("span");
            if (span) span.textContent = name.trim();
          }
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
    else if (t.id === "sessionDate" && t.value) {
      track(call("/api/admin/sessions/" + cur, "PATCH", { date: t.value })).then(reload).catch(function () {});
    } else if (t.hasAttribute("data-name") && !t.value.trim()) {
      t.value = m.byId[t.getAttribute("data-name")].name;
    }
  });

  root.addEventListener("submit", function (e) {
    if (e.target.id !== "addForm") return;
    e.preventDefault();
    var name = document.getElementById("newName").value.trim();
    if (!name) return;
    var goals = {};
    M.forEach(function (k) { goals[k.key] = Number(document.getElementById("newGoal-" + k.key).value) || 0; });
    track(call("/api/admin/people", "POST", { name: name, goals: goals })).then(reload).then(function () {
      var n = document.getElementById("newName"); if (n) n.focus();
    }).catch(function (err) { alert(err.message); });
  });

  root.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id"), p = id && m && m.byId[id];
    if (act === "retry") start();
    else if (act === "signout") signOut();
    else if (act === "new-session") {
      flush();
      track(call("/api/admin/sessions", "POST", { date: D.todayISO() })).then(function (s) { cur = s.id; return reload(); }).catch(function (err) { alert(err.message); });
    } else if (act === "del-session") {
      var s = m.desc.filter(function (x) { return x.id === cur; })[0];
      if (!confirm("Delete the " + D.fmtDate(s.date, true) + " session and all its results?")) return;
      track(call("/api/admin/sessions/" + cur, "DELETE")).then(function () { cur = null; return reload(); }).catch(function () {});
    } else if (act === "refresh-goals") {
      if (!confirm("Replace the goals stored for this session with everyone\u2019s current goals?")) return;
      flush();
      track(call("/api/admin/sessions/" + cur + "/refresh-goals", "POST")).then(reload).catch(function () {});
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
