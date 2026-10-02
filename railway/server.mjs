import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://simocosto-beep.github.io";
const AI_BASE_URL = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "";
const OWNER_PIN = String(process.env.OWNER_PIN || "").trim();
const OWNER_SESSION_SECRET = process.env.OWNER_SESSION_SECRET || "";
const OWNER_SESSION_MS = 24 * 60 * 60 * 1000;

const loginAttempts = new Map();
const requestBuckets = new Map();

function json(res, status, body, origin="*") {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-sahbi-owner-token",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

function allowedOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return "";
  if (origin === ALLOWED_ORIGIN) return origin;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return origin;
  return "";
}

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function consumeRate(req, owner=false) {
  const now = Date.now();
  const windowMs = 60000;
  const limit = owner ? 120 : 30;
  const key = clientKey(req) + ":" + (owner ? "owner" : "visitor");
  let entry = requestBuckets.get(key);
  if (!entry || now - entry.start >= windowMs) entry = { start: now, count: 0 };
  entry.count += 1;
  requestBuckets.set(key, entry);

  if (requestBuckets.size > 5000) {
    for (const [k, v] of requestBuckets) {
      if (now - v.start > 300000) requestBuckets.delete(k);
    }
  }

  return {
    ok: entry.count <= limit,
    retryAfter: Math.max(1, Math.ceil((windowMs - (now - entry.start)) / 1000)),
  };
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 220000) throw new Error("body_too_large");
  }
  return raw ? JSON.parse(raw) : {};
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(String(a).trim()), digest(String(b).trim()));
}

function signOwner(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", OWNER_SESSION_SECRET).update(encoded).digest("base64url");
  return encoded + "." + sig;
}

function verifyOwnerToken(token) {
  if (!token || !OWNER_SESSION_SECRET) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const encoded = parts[0], sig = parts[1];
  const expected = crypto.createHmac("sha256", OWNER_SESSION_SECRET).update(encoded).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload && payload.role === "owner" && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function ownerTokenFrom(req) {
  return String(req.headers["x-sahbi-owner-token"] || "");
}

function canAttemptLogin(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > 600000) {
    loginAttempts.set(key, { first: now, count: 0 });
    return true;
  }
  return entry.count < 5;
}

function noteFailedLogin(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > 600000) loginAttempts.set(key, { first: now, count: 1 });
  else {
    entry.count += 1;
    loginAttempts.set(key, entry);
  }
}

async function callModel(model, messages, owner, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      model,
      messages,
      temperature: owner ? 0.4 : 0.5,
      max_tokens: maxTokens,
      stream: false,
    };

    if (model === "stealth/space-bunny-alpha") {
      payload.reasoning = { enabled: true, exclude: true };
    } else if (/nemotron/i.test(model)) {
      payload.reasoning = { enabled: false, exclude: true };
    }

    const upstream = await fetch(AI_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + AI_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 350);
      const error = new Error("upstream_" + upstream.status);
      error.status = upstream.status;
      error.detail = detail;
      throw error;
    }

    return await upstream.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callWithFallback(messages, owner, maxTokens) {
  const candidates = [
    { model: AI_MODEL, timeout: 8000 },
    { model: "stealth/space-bunny-alpha", timeout: 9000 },
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const data = await callModel(candidate.model, messages, owner, maxTokens, candidate.timeout);
      return { data, modelUsed: candidate.model };
    } catch (error) {
      lastError = error;
      const reason = error && error.name === "AbortError" ? "timeout" : String(error && error.message || "unknown");
      console.warn("model_attempt_failed", candidate.model, reason);
    }
  }
  throw lastError || new Error("all_models_failed");
}

function finalText(data) {
  let text = String(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
  if (/here(?:'|’)s a thinking process|here is (?:my|a) thinking process|chain[- ]of[- ]thought|^analysis\s*:/i.test(text)) {
    const lines = text.split("\n");
    const idx = lines.findIndex(line => /^(final|answer|réponse finale|response)\s*[:：]/i.test(line.trim()));
    if (idx >= 0) text = lines.slice(idx + 1).join("\n").trim();
  }
  return text;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const origin = allowedOrigin(req);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "sahbi-api",
      providerConfigured: Boolean(AI_BASE_URL && AI_API_KEY && AI_MODEL),
      ownerModeConfigured: Boolean(OWNER_PIN && OWNER_SESSION_SECRET),
      version: "core-v2",
    }, origin || "*");
  }

  if (!origin) return json(res, 403, { error: "origin_not_allowed" }, "null");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-sahbi-owner-token",
    });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/api/owner/login") {
    if (!OWNER_PIN || !OWNER_SESSION_SECRET) {
      return json(res, 503, { error: "owner_not_configured" }, origin);
    }
    if (!canAttemptLogin(req)) {
      return json(res, 429, { error: "too_many_attempts", message: "Trop de tentatives. Réessaie dans quelques minutes." }, origin);
    }
    try {
      const body = await readBody(req);
      const pin = String(body.pin || "").trim();
      if (pin.length < 6 || !safeEqual(pin, OWNER_PIN)) {
        noteFailedLogin(req);
        return json(res, 401, { error: "invalid_pin", message: "PIN Owner incorrect." }, origin);
      }
      loginAttempts.delete(clientKey(req));
      const exp = Date.now() + OWNER_SESSION_MS;
      return json(res, 200, { ok: true, token: signOwner({ role: "owner", exp, v: 2 }), expiresAt: exp }, origin);
    } catch {
      return json(res, 400, { error: "invalid_request" }, origin);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/owner/status") {
    return json(res, 200, { owner: verifyOwnerToken(ownerTokenFrom(req)) }, origin);
  }

  if (req.method === "POST" && url.pathname === "/api/owner/logout") {
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    const owner = verifyOwnerToken(ownerTokenFrom(req));
    if (!owner) return json(res, 401, { error: "owner_required", message: "Mode Owner requis pour exécuter du code." }, origin);

    const rate = consumeRate(req, true);
    if (!rate.ok) {
      return json(res, 429, { error: "rate_limited", message: "Trop d'exécutions. Réessaie dans quelques secondes.", retryAfter: rate.retryAfter }, origin);
    }

    try {
      const body = await readBody(req);
      const language = String(body.language || "").toLowerCase();
      const code = String(body.code || "");
      const stdin = String(body.stdin || "");

      const allowed = new Set(["python","javascript","cpp","java"]);
      if (!allowed.has(language)) return json(res, 400, { error: "unsupported_language", message: "Langage non supporté par le runner rapide." }, origin);
      if (!code || code.length > 900) return json(res, 400, { error: "code_too_large", message: "Le runner rapide accepte jusqu'à 900 caractères par test." }, origin);
      if (stdin.length > 900) return json(res, 400, { error: "stdin_too_large" }, origin);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const upstream = await fetch("https://runlet.codealong.live/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ language, code, stdin }),
          signal: controller.signal,
        });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json(res, 502, { error: "runner_unavailable", message: "Le runner externe n'a pas accepté ce test.", detail: data?.detail || null }, origin);
        }
        return json(res, 200, {
          ok: data.status === "OK",
          status: data.status || "UNKNOWN",
          stdout: String(data.stdout || "").slice(0, 4000),
          stderr: String(data.stderr || "").slice(0, 4000),
          time: data.time ?? null,
          memory: data.memory ?? null,
          runner: "runlet",
        }, origin);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const timeout = error && error.name === "AbortError";
      return json(res, timeout ? 504 : 503, {
        error: timeout ? "runner_timeout" : "runner_error",
        message: timeout ? "Le runner a dépassé le délai." : "Le runner est momentanément indisponible."
      }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) {
      return json(res, 503, { error: "provider_not_configured", message: "Le moteur IA n'est pas configuré." }, origin);
    }

    try {
      const body = await readBody(req);
      const raw = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
      if (!raw.length) return json(res, 400, { error: "messages_required" }, origin);

      const owner = verifyOwnerToken(ownerTokenFrom(req));
      const rate = consumeRate(req, owner);
      if (!rate.ok) {
        return json(res, 429, {
          error: "rate_limited",
          message: "Trop de requêtes. Réessaie dans quelques secondes.",
          retryAfter: rate.retryAfter,
        }, origin);
      }

      const requestedMaxTokens = Math.max(1, Math.min(Number(body.max_tokens || 1400), owner ? 8000 : 5000));
      const messages = raw.map(m => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: String(m.content || "").slice(0, 20000),
      }));

      messages.unshift({
        role: "system",
        content: "You are Sahbi AI. Return only the useful final answer. Never expose chain-of-thought, hidden reasoning, scratch work, or internal analysis. Match the user's language and tone. Be concise for simple questions and thorough for complex work. Never claim to have used tools or accounts unless tool results were actually provided in the conversation."
      });

      if (owner) {
        messages.unshift({
          role: "system",
          content: "OWNER MODE AUTHENTICATED. The user is Sahbi AI's authenticated owner. Be proactive and make full use of Sahbi's implemented memory, project context, Builder and tools. Owner status grants product features, not permission to expose secrets or bypass confirmations for destructive, irreversible, financial, account-permission or external side-effect actions."
        });
      }

      const result = await callWithFallback(messages, owner, requestedMaxTokens);
      const text = finalText(result.data);
      if (!text) return json(res, 502, { error: "empty_model_response", message: "Le moteur IA a renvoyé une réponse vide." }, origin);

      return json(res, 200, { text, owner, model: result.modelUsed }, origin);
    } catch (error) {
      const timedOut = error && error.name === "AbortError";
      console.error("chat_error", timedOut ? "timeout" : String(error && error.message || error));
      return json(res, timedOut ? 504 : 503, {
        error: timedOut ? "ai_timeout" : "ai_temporarily_unavailable",
        message: timedOut ? "Le moteur IA met trop de temps. Réessaie." : "Le moteur IA est momentanément indisponible. Réessaie.",
      }, origin);
    }
  }

  return json(res, 404, { error: "not_found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("sahbi-api core-v2 listening on", PORT);
});
