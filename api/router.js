// Development hour tracker API (Vercel Function, Node.js runtime).
// All routes go through /api/router?path=<route>.
// Storage: Postgres (Neon on Vercel sets DATABASE_URL).

import postgres from "postgres";

const TOKEN_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEMA = `
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
);`;

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

// Version 1 stored fixed calls/meetings/sign-ups columns in dh_results.
// Copy that data into the flexible metric tables once; dh_results is left untouched as a backup.
async function migrateV1(sql) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    const [done] = await tx`SELECT value FROM dh_settings WHERE key = 'schema_version'`;
    if (done) return;
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
    await tx`INSERT INTO dh_settings (key, value) VALUES ('schema_version', '2')`;
  });
}

let schemaReady = null;
function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = sql.unsafe(SCHEMA)
      .catch(() => new Promise((r) => setTimeout(r, 300)).then(() => sql.unsafe(SCHEMA))) // two cold starts racing
      .then(() => migrateV1(sql))
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
async function makeToken(secret) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + TOKEN_DAYS * 864e5 })));
  return payload + "." + (await hmac(secret, payload));
}
async function checkToken(secret, request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (!(await sameText(sig, await hmac(secret, payload)))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ---------- data ----------
async function getData(sql) {
  const [settings, metrics, people, assigned, sessions, entries] = await Promise.all([
    sql`SELECT key, value FROM dh_settings`,
    sql`SELECT id, name FROM dh_metrics ORDER BY seq`,
    sql`SELECT id, name, active FROM dh_people ORDER BY seq`,
    sql`SELECT person_id, metric_id, goal FROM dh_person_metrics ORDER BY seq`,
    sql`SELECT id, to_char(date, 'YYYY-MM-DD') AS date FROM dh_sessions ORDER BY date DESC, seq DESC`,
    sql`SELECT session_id, person_id, metric_id, value, goal FROM dh_entries`,
  ]);
  const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  const byPerson = {};
  for (const a of assigned) (byPerson[a.person_id] ||= []).push({ metricId: a.metric_id, goal: a.goal });
  return {
    title: s.title || "Development hour",
    metrics: metrics.map((x) => ({ id: x.id, name: x.name })),
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

  if (resource === "settings" && method === "PUT") {
    const body = await readJSON(request);
    const title = String(body.title ?? "").trim().slice(0, 80) || "Development hour";
    await sql`INSERT INTO dh_settings (key, value) VALUES ('title', ${title})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    return json({ title });
  }

  // Metric library
  if (resource === "metrics") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const metric = { id: crypto.randomUUID(), name: cleanName(body.name, 40) };
      const goal = cleanCount(body.goal);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO dh_metrics (id, name) VALUES (${metric.id}, ${metric.name})`;
        if (body.assignAll) {
          await tx`INSERT INTO dh_person_metrics (person_id, metric_id, goal)
                   SELECT id, ${metric.id}, ${goal} FROM dh_people WHERE active ORDER BY seq`;
        }
      });
      return json(metric, 201);
    }
    const id = cleanId(rawId, "Metric");
    await mustExist(sql, "dh_metrics", id, "Metric");
    if (method === "PATCH") {
      const body = await readJSON(request);
      const name = cleanName(body.name, 40);
      await sql`UPDATE dh_metrics SET name = ${name} WHERE id = ${id}`;
      return json({ id, name });
    }
    if (method === "DELETE") {
      await sql`DELETE FROM dh_metrics WHERE id = ${id}`; // assignments and logged numbers cascade
      return json({ ok: true });
    }
  }

  if (resource === "people") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const person = { id: crypto.randomUUID(), name: cleanName(body.name), active: true };
      const copyFrom = body.copyFrom ? cleanId(body.copyFrom, "Person") : null;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO dh_people (id, name) VALUES (${person.id}, ${person.name})`;
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
      await mustExist(sql, "dh_metrics", metricId, "Metric");
      if (method === "PUT") {
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
      const session = { id: crypto.randomUUID(), date: cleanDate(body.date) };
      await sql`INSERT INTO dh_sessions (id, date) VALUES (${session.id}, ${session.date})`;
      return json(session, 201);
    }
    const id = cleanId(rawId, "Session");
    await mustExist(sql, "dh_sessions", id, "Session");

    // PUT /sessions/:id/entries/:personId  { values: { metricId: number | null } }
    if (sub === "entries" && method === "PUT") {
      const personId = cleanId(rawSubId, "Person");
      await mustExist(sql, "dh_people", personId, "Person");
      const body = await readJSON(request);
      const values = body.values && typeof body.values === "object" ? body.values : {};
      const keys = Object.keys(values);
      if (keys.length > 50) throw new HttpError(400, "Too many metrics in one save.");
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

    if (parts[0] === "data" && request.method === "GET") return json(await getData(sql));

    if (parts[0] === "login" && request.method === "POST") {
      if (!secret) throw new HttpError(500, "ADMIN_PASSWORD isn't set in the Vercel project's environment variables.");
      const body = await readJSON(request);
      if (!(await sameText(String(body.password ?? "").trim(), secret.trim()))) {
        await new Promise((r) => setTimeout(r, 600));
        throw new HttpError(401, "Wrong password.");
      }
      return json({ token: await makeToken(secret) });
    }

    if (parts[0] === "admin") {
      if (!secret || !(await checkToken(secret, request))) throw new HttpError(401, "Sign in again.");
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
