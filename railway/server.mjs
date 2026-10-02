import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://simocosto-beep.github.io";
const AI_BASE_URL = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "";

function json(res, status, body, origin="*") {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (!origin) return json(res, 403, { error: "origin_not_allowed" }, "null");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, {
      ok: true,
      service: "sahbi-api",
      providerConfigured: Boolean(AI_BASE_URL && AI_API_KEY && AI_MODEL),
    }, origin);
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
      if (!messages.length) return json(res, 400, { error: "messages_required" }, origin);

      const normalized = messages.map(m => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: String(m.content || "").slice(0, 24000),
      }));

      const upstream = await fetch(AI_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + AI_API_KEY,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: normalized,
          temperature: 0.5,
          max_tokens: 1800,
          stream: false,
        }),
      });

      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 1000);
        console.error("upstream_error", upstream.status, detail);
        return json(res, 502, { error: "upstream_ai_error" }, origin);
      }

      const data = await upstream.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return json(res, 200, { text }, origin);
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
