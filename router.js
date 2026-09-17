// Development hour tracker API (Vercel Function, Node.js runtime).
// All routes go through /api/router?path=<route>.
// Storage: any Postgres database. On Vercel, connect Neon from the Storage tab,
// which sets DATABASE_URL automatically.

import postgres from "postgres";

const METRICS = ["calls", "meetings", "signups"];
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
CREATE TABLE IF NOT EXISTS dh_results (
  session_id UUID NOT NULL REFERENCES dh_sessions(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES dh_people(id) ON DELETE CASCADE,
  calls INTEGER,
  meetings INTEGER,
  signups INTEGER,
  goal_calls INTEGER NOT NULL DEFAULT 0,
  goal_meetings INTEGER NOT NULL DEFAULT 0,
  goal_signups INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, person_id)
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

let schemaReady = null;
function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = sql.unsafe(SCHEMA)
      .catch(() => new Promise((r) => setTimeout(r, 300)).then(() => sql.unsafe(SCHEMA))) // two cold starts racing
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
function cleanName(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "Name is required.");
  if (s.length > 60) throw new HttpError(400, "Name must be 60 characters or fewer.");
  return s;
}
function cleanCount(v, nullable = false) {
  if (v === null || v === undefined || v === "") return nullable ? null : 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, "Numbers must be between 0 and 100000.");
  return Math.floor(n);
}
function cleanDate(v) {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + "T00:00:00Z"))) throw new HttpError(400, "Date must be YYYY-MM-DD.");
  return s;
}
function cleanId(v, what) {
  if (!v || !UUID.test(v)) throw new HttpError(404, what + " not found.");
  return v;
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
  const [settings, people, sessions, results] = await Promise.all([
    sql`SELECT key, value FROM dh_settings`,
    sql`SELECT * FROM dh_people ORDER BY seq`,
    sql`SELECT id, to_char(date, 'YYYY-MM-DD') AS date FROM dh_sessions ORDER BY date DESC, seq DESC`,
    sql`SELECT * FROM dh_results`,
  ]);
  const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  return {
    title: s.title || "Development hour",
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.active,
      goals: { calls: p.goal_calls, meetings: p.goal_meetings, signups: p.goal_signups },
    })),
    sessions: sessions.map((x) => ({ id: x.id, date: x.date })),
    results: results.map((r) => ({
      sessionId: r.session_id,
      personId: r.person_id,
      calls: r.calls,
      meetings: r.meetings,
      signups: r.signups,
      goals: { calls: r.goal_calls, meetings: r.goal_meetings, signups: r.goal_signups },
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

  if (resource === "people") {
    if (method === "POST" && !rawId) {
      const body = await readJSON(request);
      const g = body.goals || {};
      const person = {
        id: crypto.randomUUID(),
        name: cleanName(body.name),
        active: true,
        goals: { calls: cleanCount(g.calls), meetings: cleanCount(g.meetings), signups: cleanCount(g.signups) },
      };
      await sql`INSERT INTO dh_people (id, name, goal_calls, goal_meetings, goal_signups)
                VALUES (${person.id}, ${person.name}, ${person.goals.calls}, ${person.goals.meetings}, ${person.goals.signups})`;
      return json(person, 201);
    }
    const id = cleanId(rawId, "Person");
    const [existing] = await sql`SELECT * FROM dh_people WHERE id = ${id}`;
    if (!existing) throw new HttpError(404, "Person not found.");

    if (method === "PATCH") {
      const body = await readJSON(request);
      const g = body.goals || {};
      const name = body.name !== undefined ? cleanName(body.name) : existing.name;
      const goals = {
        calls: g.calls !== undefined ? cleanCount(g.calls) : existing.goal_calls,
        meetings: g.meetings !== undefined ? cleanCount(g.meetings) : existing.goal_meetings,
        signups: g.signups !== undefined ? cleanCount(g.signups) : existing.goal_signups,
      };
      const active = body.active !== undefined ? !!body.active : existing.active;
      await sql`UPDATE dh_people SET name = ${name}, goal_calls = ${goals.calls}, goal_meetings = ${goals.meetings},
                goal_signups = ${goals.signups}, active = ${active} WHERE id = ${id}`;
      return json({ id, name, goals, active });
    }
    if (method === "DELETE") {
      await sql`DELETE FROM dh_people WHERE id = ${id}`; // results cascade
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
    const [existing] = await sql`SELECT id FROM dh_sessions WHERE id = ${id}`;
    if (!existing) throw new HttpError(404, "Session not found.");

    if (sub === "results" && method === "PUT") {
      const personId = cleanId(rawSubId, "Person");
      const [person] = await sql`SELECT * FROM dh_people WHERE id = ${personId}`;
      if (!person) throw new HttpError(404, "Person not found.");
      const body = await readJSON(request);
      const v = {};
      for (const k of METRICS) v[k] = cleanCount(body[k], true);
      if (METRICS.every((k) => v[k] === null)) {
        await sql`DELETE FROM dh_results WHERE session_id = ${id} AND person_id = ${personId}`;
        return json({ removed: true });
      }
      // Goals are snapshotted when a result is first logged, so later goal changes don't rewrite history.
      await sql`INSERT INTO dh_results
                  (session_id, person_id, calls, meetings, signups, goal_calls, goal_meetings, goal_signups)
                VALUES (${id}, ${personId}, ${v.calls}, ${v.meetings}, ${v.signups},
                        ${person.goal_calls}, ${person.goal_meetings}, ${person.goal_signups})
                ON CONFLICT (session_id, person_id) DO UPDATE SET
                  calls = EXCLUDED.calls, meetings = EXCLUDED.meetings, signups = EXCLUDED.signups, updated_at = now()`;
      return json({ ok: true });
    }

    if (sub === "refresh-goals" && method === "POST") {
      await sql`UPDATE dh_results r SET goal_calls = p.goal_calls, goal_meetings = p.goal_meetings, goal_signups = p.goal_signups
                FROM dh_people p WHERE p.id = r.person_id AND r.session_id = ${id}`;
      return json({ ok: true });
    }

    if (!sub && method === "PATCH") {
      const body = await readJSON(request);
      const date = cleanDate(body.date);
      await sql`UPDATE dh_sessions SET date = ${date} WHERE id = ${id}`;
      return json({ id, date });
    }
    if (!sub && method === "DELETE") {
      await sql`DELETE FROM dh_sessions WHERE id = ${id}`; // results cascade
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
      if (!(await sameText(String(body.password ?? ""), secret))) {
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
