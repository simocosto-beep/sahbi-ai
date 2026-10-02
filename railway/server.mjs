import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://simocosto-beep.github.io";
const AI_BASE_URL = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "";
const OWNER_PIN = process.env.OWNER_PIN || "";
const OWNER_SESSION_SECRET = process.env.OWNER_SESSION_SECRET || "";
const OWNER_SESSION_MS = 24 * 60 * 60 * 1000;
const loginAttempts = new Map();

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
  const origin = req.headers.origin || "";
  if (!origin) return ALLOWED_ORIGIN;
  if (origin === ALLOWED_ORIGIN) return origin;
  if (origin.startsWith("http://localhost:")) return origin;
  return "";
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
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
  const [encoded, sig] = parts;
  const expected = crypto.createHmac("sha256", OWNER_SESSION_SECRET).update(encoded).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload?.role === "owner" && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function ownerTokenFrom(req) {
  return String(req.headers["x-sahbi-owner-token"] || "");
}

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function canAttemptLogin(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > 10 * 60 * 1000) {
    loginAttempts.set(key, { first: now, count: 0 });
    return true;
  }
  return entry.count < 5;
}

function noteFailedLogin(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > 10 * 60 * 1000) loginAttempts.set(key, { first: now, count: 1 });
  else {
    entry.count += 1;
    loginAttempts.set(key, entry);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (!origin) return json(res, 403, { error: "origin_not_allowed" }, "null");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-sahbi-owner-token",
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, {
      ok: true,
      service: "sahbi-api",
      providerConfigured: Boolean(AI_BASE_URL && AI_API_KEY && AI_MODEL),
      ownerModeConfigured: Boolean(OWNER_PIN && OWNER_SESSION_SECRET),
    }, origin);
  }

  if (req.method === "POST" && req.url === "/api/owner/login") {
    if (!OWNER_PIN || !OWNER_SESSION_SECRET) {
      return json(res, 503, { error: "owner_not_configured" }, origin);
    }
    if (!canAttemptLogin(req)) {
      return json(res, 429, { error: "too_many_attempts", message: "Trop de tentatives. Réessaie dans quelques minutes." }, origin);
    }
    try {
      const body = await readBody(req);
      const pin = String(body.pin || "");
      if (pin.length < 6 || !safeEqual(pin, OWNER_PIN)) {
        noteFailedLogin(req);
        return json(res, 401, { error: "invalid_pin" }, origin);
      }
      loginAttempts.delete(clientKey(req));
      const exp = Date.now() + OWNER_SESSION_MS;
      return json(res, 200, { ok: true, token: signOwner({ role: "owner", exp, v: 1 }), expiresAt: exp }, origin);
    } catch {
      return json(res, 400, { error: "invalid_request" }, origin);
    }
  }

  if (req.method === "GET" && req.url === "/api/owner/status") {
    return json(res, 200, { owner: verifyOwnerToken(ownerTokenFrom(req)) }, origin);
  }

  if (req.method === "POST" && req.url === "/api/owner/logout") {
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) {
      return json(res, 503, {
        error: "provider_not_configured",
        message: "Sahbi backend is online, but no inference provider is configured yet."
      }, origin);
    }

    try {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
      const requestedMaxTokens = Math.max(1, Math.min(Number(body.max_tokens || 1800), 8000));
      if (!messages.length) return json(res, 400, { error: "messages_required" }, origin);

      const owner = verifyOwnerToken(ownerTokenFrom(req));
      const normalized = messages.map(m => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: String(m.content || "").slice(0, 24000),
      }));

      normalized.unshift({
        role: "system",
        content: "Return only the final answer for the user. Never reveal chain-of-thought, hidden reasoning, scratch work, internal analysis, or a thinking process. Do not write phrases such as 'Here is my thinking process', 'Analysis', or step-by-step private reasoning. Keep internal reasoning private and answer naturally, directly, and concisely in the user's language."
      });

      if (owner) {
        normalized.unshift({
          role: "system",
          content: "OWNER MODE AUTHENTICATED. The user is the authenticated owner of Sahbi AI. Treat them as a trusted owner: use their saved project context and advanced Sahbi capabilities when available, be proactive and concise, and distinguish owner-only app/admin actions from visitor actions. Never expose credentials or secrets. Keep confirmations for destructive, irreversible, financial, account-permission, or external side-effect actions. Do not claim capabilities that are not actually implemented."
        });
      }

      const upstream = await fetch(AI_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + AI_API_KEY,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: normalized,
          temperature: owner ? 0.45 : 0.5,
          max_tokens: requestedMaxTokens,
          reasoning: { enabled: false, exclude: true },
          stream: false,
        }),
      });

      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 1000);
        console.error("upstream_error", upstream.status, detail);
        return json(res, 502, { error: "upstream_ai_error" }, origin);
      }

      const data = await upstream.json();
      let text = String(data?.choices?.[0]?.message?.content || "").trim();
      if (/here(?:'|’)s a thinking process|here is (?:my|a) thinking process|chain[- ]of[- ]thought|^analysis\s*:/i.test(text)) {
        const lines = text.split("\n");
        const finalIndex = lines.findIndex(line => /^(final|answer|réponse finale|response)\s*[:：]/i.test(line.trim()));
        if (finalIndex >= 0) text = lines.slice(finalIndex + 1).join("\n").trim();
      }
      return json(res, 200, { text, owner }, origin);
    } catch (error) {
      console.error("chat_error", error);
      return json(res, 500, { error: "internal_error" }, origin);
    }
  }

  return json(res, 404, { error: "not_found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("sahbi-api listening on", PORT);
});
