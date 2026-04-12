/**
 * Jeeves API — Cloudflare Worker
 *
 * Endpoints:
 *   POST /signup    — email + persona → creates user, returns API key
 *   POST /check     — api_key + skill → validates license, returns allow/deny
 *   POST /events    — api_key + event data → logs usage
 *   POST /feedback  — api_key + feedback signal → logs feedback
 *   GET  /health    — status check
 */

interface Env {
  DB: D1Database;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `jvs_${key}`;
}

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, { ...response, headers });
}

function json(data: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ── Signup ──────────────────────────────────────────────

async function handleSignup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { email?: string; persona?: string };

  if (!body.email || !body.email.includes("@")) {
    return json({ error: "Valid email required" }, 400);
  }

  const persona = body.persona === "explorer" ? "explorer" : "builder";

  // Check if user already exists
  const existing = await env.DB.prepare("SELECT api_key, plan, status FROM users WHERE email = ?")
    .bind(body.email)
    .first();

  if (existing) {
    return json({
      api_key: existing.api_key,
      plan: existing.plan,
      persona,
      status: existing.status,
      message: "Account already exists. Here's your API key.",
    });
  }

  // Create new user with 14-day trial
  const apiKey = generateApiKey();
  const trialExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO users (email, api_key, plan, persona, status, trial_expires_at) VALUES (?, ?, 'trial', ?, 'active', ?)"
  )
    .bind(body.email, apiKey, persona, trialExpires)
    .run();

  return json({
    api_key: apiKey,
    plan: "trial",
    persona,
    trial_expires_at: trialExpires,
    message: "Welcome to Jeeves! 14-day Pro trial started.",
  });
}

// ── License Check ───────────────────────────────────────

// Skills that are free (no license needed)
const FREE_SKILLS = new Set(["jeeves", "end", "summary", "jeeves-rules"]);

async function handleCheck(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    skill?: string;
    version?: string;
    stats?: Record<string, unknown>;
  };

  // No key — free tier only
  if (!body.key) {
    const isFree = FREE_SKILLS.has(body.skill || "");
    return json({
      decision: isFree ? "allow" : "deny",
      plan: "free",
      reason: isFree ? undefined : "No API key. Free modes: /jeeves, /jeeves:end, /jeeves:summary. Get a key at trustjeeves.com",
    });
  }

  // Look up user
  const user = await env.DB.prepare(
    "SELECT id, plan, persona, status, trial_expires_at FROM users WHERE api_key = ?"
  )
    .bind(body.key)
    .first();

  if (!user) {
    return json({ decision: "deny", reason: "Invalid API key. Sign up at trustjeeves.com" }, 401);
  }

  // Check trial expiration
  let plan = user.plan as string;
  if (plan === "trial" && user.trial_expires_at) {
    const expires = new Date(user.trial_expires_at as string);
    if (expires < new Date()) {
      // Trial expired — downgrade to free
      await env.DB.prepare("UPDATE users SET plan = 'free', status = 'expired' WHERE id = ?")
        .bind(user.id)
        .run();
      plan = "free";
    }
  }

  // Check if skill is allowed for plan
  const isFree = FREE_SKILLS.has(body.skill || "");
  const isPro = plan === "trial" || plan === "pro" || plan === "team";

  const allowed = isFree || isPro;

  // Log the event (non-blocking — fire and forget)
  if (body.stats || body.skill) {
    const keyHash = await hashKey(body.key);
    const stats = body.stats || {};
    env.DB.prepare(
      `INSERT INTO events (api_key_hash, event_type, skill, mode, actions, actions_by_type, health_score, patterns, decisions, concepts, max_docs_per_concept, max_files_per_doc, version)
       VALUES (?, 'skill_check', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        keyHash,
        body.skill || null,
        (stats.mode as string) || null,
        (stats.actions as number) || null,
        JSON.stringify(stats.actions_by_type || null),
        (stats.health_score as number) || null,
        (stats.patterns as number) || null,
        (stats.decisions as number) || null,
        (stats.concepts as number) || null,
        (stats.max_docs_per_concept as number) || null,
        (stats.max_files_per_doc as number) || null,
        body.version || null
      )
      .run();
  }

  return json({
    decision: allowed ? "allow" : "deny",
    plan,
    persona: user.persona,
    reason: allowed
      ? undefined
      : `Pro trial expired. Free modes still work. Upgrade at trustjeeves.com/upgrade`,
  });
}

// ── Events ──────────────────────────────────────────────

async function handleEvents(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    event_type?: string;
    skill?: string;
    stats?: Record<string, unknown>;
  };

  const keyHash = body.key ? await hashKey(body.key) : "anonymous";
  const stats = body.stats || {};

  await env.DB.prepare(
    `INSERT INTO events (api_key_hash, event_type, skill, mode, actions, health_score, patterns, decisions, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      keyHash,
      body.event_type || "unknown",
      body.skill || null,
      (stats.mode as string) || null,
      (stats.actions as number) || null,
      (stats.health_score as number) || null,
      (stats.patterns as number) || null,
      (stats.decisions as number) || null,
      (stats.version as string) || null
    )
    .run();

  return json({ ok: true });
}

// ── Feedback ────────────────────────────────────────────

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    skill?: string;
    actions?: number;
    feedback?: string;
  };

  if (!body.feedback || !["yes", "no", "too_many", "too_few"].includes(body.feedback)) {
    return json({ error: "feedback must be: yes, no, too_many, or too_few" }, 400);
  }

  const keyHash = body.key ? await hashKey(body.key) : "anonymous";

  await env.DB.prepare(
    "INSERT INTO events (api_key_hash, event_type, skill, actions, feedback) VALUES (?, 'feedback', ?, ?, ?)"
  )
    .bind(keyHash, body.skill || null, body.actions || null, body.feedback)
    .run();

  return json({ ok: true, message: "Thanks for the feedback!" });
}

// ── Health ──────────────────────────────────────────────

async function handleHealth(env: Env): Promise<Response> {
  const userCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
  const eventCount = await env.DB.prepare("SELECT COUNT(*) as count FROM events").first();

  return json({
    status: "ok",
    version: "0.1.0",
    users: userCount?.count || 0,
    events: eventCount?.count || 0,
  });
}

// ── Router ──────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return handleHealth(env);
      }
      if (url.pathname === "/signup" && request.method === "POST") {
        return handleSignup(request, env);
      }
      if (url.pathname === "/check" && request.method === "POST") {
        return handleCheck(request, env);
      }
      if (url.pathname === "/events" && request.method === "POST") {
        return handleEvents(request, env);
      }
      if (url.pathname === "/feedback" && request.method === "POST") {
        return handleFeedback(request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Internal error", detail: String(e) }, 500);
    }
  },
};
