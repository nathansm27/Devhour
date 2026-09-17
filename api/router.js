I// Development hour tracker API (Vercel Function, Node.js runtime).
// All routes go through /api/router?path=<route>.

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
      .catch(() => new Promise((r) => setTimeout(r, 300)).then(() => sql.unsafe(SCHEMA)))
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

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

async function getData(sql) {
  c
