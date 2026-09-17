// Development hour tracker API (Vercel Function, Node.js runtime).
// All routes go through /api/router?path=<route>.
// Storage: Postgres (Neon on Vercel sets DATABASE_URL).

import postgres from "postgres";
import { randomInt } from "node:crypto";

const TOKEN_DAYS = 30;
const SELF_TOKEN_DAYS = 90;
const PIN_TRIES = 5;          // wrong PINs before a person is locked out
const PIN_LOCK_MINUTES = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dh_teams (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  seq BIGSERIAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dh_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dh_people (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  goal_calls INTEGER NOT NULL DEFAULT 0,
  goal_meetings INTEGER NOT NULL DEFAULT 0,
  goal_signups INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  seq BIGSERIAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dh_sessions (
  id UUID PRIMARY KEY,
  date DATE NOT NULL,
  seq BIGSERIAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dh_metrics (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  seq BIGSERIAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dh_person_metrics (
  person_id UUID NOT NULL REFERENCES dh_people(id) ON DELETE CASCADE,
  metric_id UUID NOT NULL REFERENCES dh_metrics(id) ON DELETE CASCADE,
  goal INTEGER NOT NULL DEFAULT 0,
  seq BIGSERIAL,
  PRIMARY KEY (person_id, metric_id)
);
CREATE TABLE IF NOT EXISTS dh_entries (
  session_id UUID NOT NULL REFERENCES dh_sessions(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES dh_people(id) ON DELETE CASCADE,
  metric_id UUID NOT NULL REFERENCES dh_metrics(id) ON DELETE CASCADE,
  value INTEGER NOT NULL,
  goal INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, person_id, metric_id)
);
ALTER TABLE dh_people ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES dh_teams(id) ON DELETE CASCADE;
ALTER TABLE dh_sessions ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES dh_teams(id) ON DELETE CASCADE;
ALTER TABLE dh_metrics ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES dh_teams(id) ON DELETE CASCADE;
ALTER TABLE dh_metrics ADD COLUMN IF NOT EXISTS default_goal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dh_people ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE dh_people ADD COLUMN IF NOT EXISTS pin_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dh_people ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- database ----------
function db() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new HttpError(500, "No database connected. Add a Neon (Postgres) database to this Vercel project.");
  if (!globalThis.__dhSql) {
    globalThis.__dhSql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false, onnotice: () => {} });
  }
  return globalThis.__dhSql;
}

// Schema history:
//   v1  fixed calls/meetings/sign-ups columns in dh_results
//   v2  flexible metrics (dh_metrics, dh_person_metrics, dh_entries)
//   v3  teams: people, sessions and metrics belong to a team
async function migrate(sql) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    const [row] = await tx`SELECT value FROM dh_settings WHERE key = 'schema_version'`;
    const version = row ? Number(row.value) : 1;

    if (version < 2) {
      // Copy v1 data into metrics once; dh_results is left untouched as a backup.
      const [old] = await tx`SELECT to_regclass('dh_results') AS t`;
      const oldRows = old.t ? await tx`SELECT * FROM dh_results` : [];
      if (oldRows.length) {
        const legacy = [["calls", "Calls"], ["meetings", "Meetings"], ["signups", "Sign-ups"]];
        const ids = {};
        for (const [key, name] of legacy) {
          ids[key] = crypto.randomUUID();
          await tx`INSERT INTO dh_metrics (id, name) VALUES (${ids[key]}, ${name})`;
        }
        const people = await tx`SELECT * FROM dh_people ORDER BY seq`;
        for (const p of people) {
          for (const [key] of legacy) {
            await tx`INSERT INTO dh_person_metrics (person_id, metric_id, goal) VALUES (${p.id}, ${ids[key]}, ${p["goal_" + key]})`;
          }
        }
        for (const r of oldRows) {
          for (const [key] of legacy) {
            if (r[key] === null) continue;
            await tx`INSERT INTO dh_entries (session_id, person_id, metric_id, value, goal)
                     VALUES (${r.session_id}, ${r.person_id}, ${ids[key]}, ${r[key]}, ${r["goal_" + key]})
                     ON CONFLICT DO NOTHING`;
          }
        }
      }
    }

    if (version < 3) {
      // Everything that existed before teams belongs to Recruitment; Admin starts empty.
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM dh_teams`;
      if (!n) {
        await tx`INSERT INTO dh_teams (id, name, slug) VALUES (${crypto.randomUUID()}, 'Recruitment', 'recruitment')`;
        await tx`INSERT INTO dh_teams (id, name, slug) VALUES (${crypto.randomUUID()}, 'Admin', 'admin')`;
      }
      const [first] = await tx`SELECT id FROM dh_teams ORDER BY seq LIMIT 1`;
      await tx`UPDATE dh_people SET team_id = ${first.id} WHERE team_id IS NULL`;
      await tx`UPDATE dh_sessions SET team_id = ${first.id} WHERE team_id IS NULL`;
      await tx`UPDATE dh_metrics SET team_id = ${first.id} WHERE team_id IS NULL`;
    }

    // Everyone needs a PIN to log their own numbers from the leaderboard.
    const noPin = await tx`SELECT id FROM dh_people WHERE pin IS NULL`;
    for (const p of noPin) await tx`UPDATE dh_people SET pin = ${newPin()} WHERE id = ${p.id}`;

    if (version < 3) {
      await tx`INSERT INTO dh_settings (key, value) VALUES ('schema_version', '3')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
  });
}

let schemaReady = null;
function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = sql.unsafe(SCHEMA)
      .catch(() => new Promise((r) => setTimeout(r, 300)).then(() => sql.unsafe(SCHEMA))) // two cold starts racing
      .then(() => migrate(sql))
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- helpers ----------
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function readJSON(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Body must be JSON."); }
}
function cleanName(v, max = 60) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "Name is required.");
  if (s.length > max) throw new HttpError(400, `Name must be ${max} characters or fewer.`);
  return s;
}
function cleanCount(v, nullable = false) {
  if (v === null || v === undefined || v === "") return nullable ? null : 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new HttpError(400, "Numbers must be between 0 and 1,000,000.");
  return Math.floor(n);
}
function cleanDate(v) {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + "T00:00:00Z"))) throw new HttpError(400, "Date must be YYYY-MM-DD.");
  return s;
}
function cleanId(v, what) {
  if (!v || !UUID.test(v)) throw new HttpError(404, what + " not found.");
  return v.toLowerCase();
}
function newPin() {
  return String(randomInt(0, 10000)).padStart(4, "0");
}
// Today's date in London as YYYY-MM-DD.
function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function slugify(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}
async function uniqueSlug(sql, name) {
  const base = slugify(name);
  let slug = base, i = 2;
  // "admin" is also the admin page's path, which is fine: team links use ?team=
  while ((await sql`SELECT 1 FROM dh_teams WHERE slug = ${slug}`).length) slug = base + "-" + i++;
  return slug;
}
async function teamFrom(sql, value) {
  const v = String(value ?? "").trim().toLowerCase();
  const rows = v
    ? await sql`SELECT id, name, slug FROM dh_teams WHERE slug = ${v} OR id::text = ${v}`
    : await sql`SELECT id, name, slug FROM dh_teams ORDER BY seq LIMIT 1`;
  if (!rows.length) throw new HttpError(404, "Team not found.");
  return rows[0];
}
function sameTeam(...rows) {
  const t = rows[0].team_id;
  if (!rows.every((r) => r.team_id === t)) throw new HttpError(400, "Those belong to different teams.");
}
async function mustExist(sql, table, id, what) {
  const [row] = await sql`SELECT * FROM ${sql(table)} WHERE id = ${id}`;
  if (!row) throw new HttpError(404, what + " not found.");
  return row;
}

// ---------- auth ----------
const enc = new TextEncoder();
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}
async function sameText(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
// Tokens are "<base64 payload>.<HMAC>". Admin tokens carry {exp}; personal tokens carry {exp, pid}
// and are signed with a key that includes the person's PIN, so a new PIN signs them out.
async function makeToken(key, extra = {}, days = TOKEN_DAYS) {
  const payload = b64url(enc.encode(JSON.stringify({ ...extra, exp: Date.now() + days * 864e5 })));
  return payload + "." + (await hmac(key, payload));
}
function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
function peek(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")); } catch { return null; }
}
async function verify(token, key) {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!(await sameText(sig, await hmac(key, payload)))) return null;
  const d = peek(token);
  return d && typeof d.exp === "number" && d.exp > Date.now() ? d : null;
}
async function checkAdmin(secret, request) {
  const d = await verify(bearer(request), secret);
  return !!d && !d.pid;
}
const selfKey = (secret, person) => secret + "|self|" + person.id + "|" + person.pin;
async function checkSelf(sql, secret, request) {
  const token = bearer(request);
  const pid = peek(token)?.pid;
  if (!pid || !UUID.test(pid)) return null;
  const [person] = await sql`SELECT * FROM dh_people WHERE id = ${pid}`;
  if (!person || !person.active || !person.pin) return null;
  return (await verify(token, selfKey(secret, person))) ? person : null;
}

// ---------- self-logging (from the leaderboard, with a PIN) ----------
async function self(request, sql, secret, parts) {
  const method = request.method;

  if (parts[0] === "login" && method === "POST") {
    const body = await readJSON(request);
    const pid = cleanId(body.personId, "Person");
    const [p] = await sql`SELECT * FROM dh_people WHERE id = ${pid}`;
    if (!p || !p.active) throw new HttpError(404, "Person not found.");
    if (p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) {
      throw new HttpError(429, `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} minutes.`);
    }
    if (!(await sameText(String(body.pin ?? "").trim(), p.pin || ""))) {
      const fails = p.pin_fails + 1;
      if (fails >= PIN_TRIES) {
        await sql`UPDATE dh_people SET pin_fails = 0, pin_locked_until = now() + ${PIN_LOCK_MINUTES + " minutes"}::interval WHERE id = ${pid}`;
      } else {
        await sql`UPDATE dh_people SET pin_fails = ${fails} WHERE id = ${pid}`;
      }
      await new Promise((r) => setTimeout(r, 600));
      throw new HttpError(401, fails >= PIN_TRIES ? `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} minutes.` : "Wrong PIN.");
    }
    await sql`UPDATE dh_people SET pin_fails = 0, pin_locked_until = NULL WHERE id = ${pid}`;
    return json({ token: await makeToken(selfKey(secret, p), { pid }, SELF_TOKEN_DAYS), personId: pid });
  }

  // PUT /self/entries { values: { metricId: number | null } } -> today's session for the person's team
  if (parts[0] === "entries" && method === "PUT") {
    const person = await checkSelf(sql, secret, request);
    if (!person) throw new HttpError(401, "Enter your PIN again.");
    const body = await readJSON(request);
    const values = body.values && typeof body.values === "object" ? body.values : {};
    const keys = Object.keys(values);
    if (!keys.length || keys.length > 50) throw new HttpError(400, "Nothing to save.");
    const metricIds = keys.map((k) => cleanId(k, "Metric"));
    const mine = await sql`SELECT metric_id FROM dh_person_metrics WHERE person_id = ${person.id} AND metric_id IN ${sql(metricIds)}`;
    if (mine.length !== metricIds.length) throw new HttpError(403, "You can only log your own metrics.");
    const today = londonToday();

    const sessionId = await sql.begin(async (tx) => {
      // One session per team per day; the first person to log creates it.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${person.team_id + today}))`;
      let [session] = await tx`SELECT id FROM dh_sessions WHERE team_id = ${person.team_id} AND date = ${today} ORDER BY seq LIMIT 1`;
      if (!session) {
        session = { id: crypto.randomUUID() };
        await tx`INSERT INTO dh_sessions (id, date, team_id) VALUES (${session.id}, ${today}, ${person.team_id})`;
      }
      for (let i = 0; i < keys.length; i++) {
        const v = cleanCount(values[keys[i]], true);
        const metricId = metricIds[i];
        if (v === null) {
          await tx`DELETE FROM dh_entries WHERE session_id = ${session.id} AND person_id = ${person.id} AND metric_id = ${metricId}`;
          continue;
        }
        await tx`INSERT INTO dh_entries (session_id, person_id, metric_id, value, goal)
                 SELECT ${session.id}, ${person.id}, ${metricId}, ${v}, goal FROM dh_person_metrics
                 WHERE person_id = ${person.id} AND metric_id = ${metricId}
                 ON CONFLICT (session_id, person_id, metric_id)
                 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      }
      return session.id;
    });
    return json({ sessionId, date: today });
  }

  throw new HttpError(404, "Not found.");
}

// ---------- data ----------
async function getData(sql, teamParam) {
  const team = await teamFrom(sql, teamParam);
  const [settings, teams, metrics, people, assigned, sessions, entries] = await Promise.all([
    sql`SELECT key, value FROM dh_settings`,
    sql`SELECT id, name, slug FROM dh_teams ORDER BY seq`,
    sql`SELECT id, name, default_goal FROM dh_metrics WHERE team_id = ${team.id} ORDER BY seq`,
    sql`SELECT id, name, active FROM dh_people WHERE team_id = ${team.id} ORDER BY seq`,
    sql`SELECT pm.person_id, pm.metric_id, pm.goal FROM dh_person_metrics pm
        JOIN dh_people p ON p.id = pm.person_id WHERE p.team_id = ${team.id} ORDER BY pm.seq`,
    sql`SELECT id, to_char(date, 'YYYY-MM-DD') AS date FROM dh_sessions WHERE team_id = ${team.id} ORDER BY date DESC, seq DESC`,
    sql`SELECT e.session_id, e.person_id, e.metric_id, e.value, e.goal FROM dh_entries e
        JOIN dh_sessions s ON s.id = e.session_id WHERE s.team_id = ${team.id}`,
  ]);
  const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  const byPerson = {};
  for (const a of assigned) (byPerson[a.person_id] ||= []).push({ metricId: a.metric_id, goal: a.goal });
  return {
    title: s.title || "Development hour",
    team: { id: team.id, name: team.name, slug: team.slug },
    teams: teams.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
    metrics: metrics.map((x) => ({ id: x.id, name: x.name, defaultGoal: x.default_goal })),
    people: people.map((p) => ({ id: p.id, name: p.name, active: p.active, metrics: byPerson[p.id] || [] })),
    sessions: sessions.map((x) => ({ id: x.id, date: x.date })),
    entries: entries.map((e) => ({
      sessionId: e.session_id, personId: e.person_id, metricId: e.metric_id, value: e.value, goal: e.goal,
    })),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- admin routes ----------
async function admin(request, sql, parts) {
  const method = request.method;
  const [resource, rawId, sub, rawSubId] = parts;

  if (resource === "check" && method === "GET") return json({ ok: true });

  // PINs are only ever sent to the admin page.
  if (resource === "pins" && method === "GET") {
    const team = await teamFrom(sql, new URL(request.url).searchParams.get("team"));
    const rows = await sql`SELECT id, pin FROM dh_people WHERE team_id = ${team.id}`;
    return json(Object.fromEntries(rows.map((r) => [r.id, r.pin])));
  }

  if (resource === "settings" && method === "PUT") {
    const body = await readJSON(request);
    const title = String(body.title ?? "").trim().slice(0, 80) || "Development hour";
    await sql`INSERT INTO dh_settings (key, value) VALUES ('title', ${title})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    return json({ title });
  }

  if (resource === "teams") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const name = cleanName(body.name, 40);
      const team = { id: crypto.randomUUID(), name, slug: await uniqueSlug(sql, name) };
      await sql`INSERT INTO dh_teams (id, name, slug) VALUES (${team.id}, ${team.name}, ${team.slug})`;
      return json(team, 201);
    }
    const id = cleanId(rawId, "Team");
    await mustExist(sql, "dh_teams", id, "Team");
    if (method === "PATCH") {
      // The link (slug) stays the same when a team is renamed, so shared links keep working.
      const body = await readJSON(request);
      const name = cleanName(body.name, 40);
      await sql`UPDATE dh_teams SET name = ${name} WHERE id = ${id}`;
      return json({ id, name });
    }
  }

  // Metric library (per team)
  if (resource === "metrics") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const team = await teamFrom(sql, body.teamId);
      const metric = { id: crypto.randomUUID(), name: cleanName(body.name, 40) };
      const goal = cleanCount(body.goal);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO dh_metrics (id, name, team_id, default_goal) VALUES (${metric.id}, ${metric.name}, ${team.id}, ${goal})`;
        if (body.assignAll) {
          await tx`INSERT INTO dh_person_metrics (person_id, metric_id, goal)
                   SELECT id, ${metric.id}, ${goal} FROM dh_people WHERE active AND team_id = ${team.id} ORDER BY seq`;
        }
      });
      return json(metric, 201);
    }
    const id = cleanId(rawId, "Metric");
    const metric = await mustExist(sql, "dh_metrics", id, "Metric");
    if (method === "PATCH") {
      const body = await readJSON(request);
      const name = body.name !== undefined ? cleanName(body.name, 40) : metric.name;
      const defaultGoal = body.defaultGoal !== undefined ? cleanCount(body.defaultGoal) : metric.default_goal;
      await sql`UPDATE dh_metrics SET name = ${name}, default_goal = ${defaultGoal} WHERE id = ${id}`;
      return json({ id, name, defaultGoal });
    }
    if (method === "DELETE") {
      await sql`DELETE FROM dh_metrics WHERE id = ${id}`; // assignments and logged numbers cascade
      return json({ ok: true });
    }
  }

  if (resource === "people") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const team = await teamFrom(sql, body.teamId);
      const person = { id: crypto.randomUUID(), name: cleanName(body.name), active: true };
      // copyFrom: "all" = every team metric at its default goal, or a person's id to copy their metrics and goals
      const allMetrics = body.copyFrom === "all";
      const copyFrom = body.copyFrom && !allMetrics ? cleanId(body.copyFrom, "Person") : null;
      if (copyFrom) sameTeam(await mustExist(sql, "dh_people", copyFrom, "Person"), { team_id: team.id });
      await sql.begin(async (tx) => {
        await tx`INSERT INTO dh_people (id, name, team_id, pin) VALUES (${person.id}, ${person.name}, ${team.id}, ${newPin()})`;
        if (allMetrics) {
          await tx`INSERT INTO dh_person_metrics (person_id, metric_id, goal)
                   SELECT ${person.id}, id, default_goal FROM dh_metrics WHERE team_id = ${team.id} ORDER BY seq`;
        }
        if (copyFrom) {
          await tx`INSERT INTO dh_person_metrics (person_id, metric_id, goal)
                   SELECT ${person.id}, metric_id, goal FROM dh_person_metrics WHERE person_id = ${copyFrom} ORDER BY seq`;
        }
      });
      return json(person, 201);
    }
    const id = cleanId(rawId, "Person");
    const existing = await mustExist(sql, "dh_people", id, "Person");

    // PUT / DELETE /people/:id/metrics/:metricId
    if (sub === "metrics") {
      const metricId = cleanId(rawSubId, "Metric");
      const metric = await mustExist(sql, "dh_metrics", metricId, "Metric");
      if (method === "PUT") {
        sameTeam(existing, metric);
        const body = await readJSON(request);
        const goal = cleanCount(body.goal);
        await sql`INSERT INTO dh_person_metrics (person_id, metric_id, goal) VALUES (${id}, ${metricId}, ${goal})
                  ON CONFLICT (person_id, metric_id) DO UPDATE SET goal = EXCLUDED.goal`;
        return json({ personId: id, metricId, goal });
      }
      if (method === "DELETE") {
        // Past numbers stay in history; the metric just stops appearing for new sessions.
        await sql`DELETE FROM dh_person_metrics WHERE person_id = ${id} AND metric_id = ${metricId}`;
        return json({ ok: true });
      }
    }

    if (!sub && method === "PATCH") {
      const body = await readJSON(request);
      if (body.newPin) {
        const pin = newPin();
        await sql`UPDATE dh_people SET pin = ${pin}, pin_fails = 0, pin_locked_until = NULL WHERE id = ${id}`;
        return json({ id, pin });
      }
      const name = body.name !== undefined ? cleanName(body.name) : existing.name;
      const active = body.active !== undefined ? !!body.active : existing.active;
      await sql`UPDATE dh_people SET name = ${name}, active = ${active} WHERE id = ${id}`;
      return json({ id, name, active });
    }
    if (!sub && method === "DELETE") {
      await sql`DELETE FROM dh_people WHERE id = ${id}`; // assignments and entries cascade
      return json({ ok: true });
    }
  }

  if (resource === "sessions") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const team = await teamFrom(sql, body.teamId);
      const session = { id: crypto.randomUUID(), date: cleanDate(body.date) };
      await sql`INSERT INTO dh_sessions (id, date, team_id) VALUES (${session.id}, ${session.date}, ${team.id})`;
      return json(session, 201);
    }
    const id = cleanId(rawId, "Session");
    const session = await mustExist(sql, "dh_sessions", id, "Session");

    // PUT /sessions/:id/entries/:personId  { values: { metricId: number | null } }
    if (sub === "entries" && method === "PUT") {
      const personId = cleanId(rawSubId, "Person");
      const person = await mustExist(sql, "dh_people", personId, "Person");
      sameTeam(session, person);
      const body = await readJSON(request);
      const values = body.values && typeof body.values === "object" ? body.values : {};
      const keys = Object.keys(values);
      if (keys.length > 50) throw new HttpError(400, "Too many metrics in one save.");
      const metricIds = keys.map((k) => cleanId(k, "Metric"));
      const metricRows = metricIds.length ? await sql`SELECT id, team_id FROM dh_metrics WHERE id IN ${sql(metricIds)}` : [];
      if (metricRows.length !== metricIds.length) throw new HttpError(404, "Metric not found.");
      sameTeam(session, ...metricRows);
      await sql.begin(async (tx) => {
        for (const raw of keys) {
          const metricId = cleanId(raw, "Metric");
          const v = cleanCount(values[raw], true);
          if (v === null) {
            await tx`DELETE FROM dh_entries WHERE session_id = ${id} AND person_id = ${personId} AND metric_id = ${metricId}`;
            continue;
          }
          // The goal is copied when a number is first logged, so later goal changes don't rewrite history.
          await tx`INSERT INTO dh_entries (session_id, person_id, metric_id, value, goal)
                   SELECT ${id}, ${personId}, m.id, ${v},
                          COALESCE((SELECT goal FROM dh_person_metrics WHERE person_id = ${personId} AND metric_id = m.id), 0)
                   FROM dh_metrics m WHERE m.id = ${metricId}
                   ON CONFLICT (session_id, person_id, metric_id)
                   DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
        }
      });
      return json({ ok: true });
    }

    if (sub === "refresh-goals" && method === "POST") {
      await sql`UPDATE dh_entries e SET goal = pm.goal
                FROM dh_person_metrics pm
                WHERE pm.person_id = e.person_id AND pm.metric_id = e.metric_id AND e.session_id = ${id}`;
      return json({ ok: true });
    }

    if (!sub && method === "PATCH") {
      const body = await readJSON(request);
      const date = cleanDate(body.date);
      await sql`UPDATE dh_sessions SET date = ${date} WHERE id = ${id}`;
      return json({ id, date });
    }
    if (!sub && method === "DELETE") {
      await sql`DELETE FROM dh_sessions WHERE id = ${id}`; // entries cascade
      return json({ ok: true });
    }
  }

  throw new HttpError(404, "Not found.");
}

// ---------- entry ----------
export async function handle(request) {
  try {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "") === "/api/router"
      ? url.searchParams.get("path") || ""
      : url.pathname.replace(/^\/api\/?/, "");
    const parts = route.split("/").filter(Boolean);
    const secret = process.env.ADMIN_PASSWORD;

    const sql = db();
    await ensureSchema(sql);

    if (parts[0] === "data" && request.method === "GET") return json(await getData(sql, url.searchParams.get("team")));

    if (parts[0] === "login" && request.method === "POST") {
      if (!secret) throw new HttpError(500, "ADMIN_PASSWORD isn't set in the Vercel project's environment variables.");
      const body = await readJSON(request);
      if (!(await sameText(String(body.password ?? "").trim(), secret.trim()))) {
        await new Promise((r) => setTimeout(r, 600));
        throw new HttpError(401, "Wrong password.");
      }
      return json({ token: await makeToken(secret) });
    }

    if (parts[0] === "self") {
      if (!secret) throw new HttpError(500, "ADMIN_PASSWORD isn't set in the Vercel project's environment variables.");
      return await self(request, sql, secret, parts.slice(1));
    }

    if (parts[0] === "admin") {
      if (!secret || !(await checkAdmin(secret, request))) throw new HttpError(401, "Sign in again.");
      return await admin(request, sql, parts.slice(1));
    }

    throw new HttpError(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
