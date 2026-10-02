import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

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
  const host = String(req.headers.host || "");
  if (origin === ALLOWED_ORIGIN) return origin;
  if (host && (origin === "https://" + host || origin === "http://" + host)) return origin;
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
  const builderLike = maxTokens >= 3000;
  const candidates = builderLike
    ? [
        { model: "openrouter/free", timeout: 16000 },
        { model: AI_MODEL, timeout: 9000 },
      ]
    : [
        { model: "openrouter/free", timeout: 10000 },
        { model: AI_MODEL, timeout: 6000 },
      ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const data = await callModel(candidate.model, messages, owner, maxTokens, candidate.timeout);
      const text = finalText(data);
      if (!text) {
        const empty = new Error("empty_model_response");
        console.warn("model_attempt_failed", candidate.model, "empty_response");
        lastError = empty;
        continue;
      }
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


function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") ||
      s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") ||
      s.startsWith("ff") || s.startsWith("2001:db8:");
  }
  return true;
}

async function resolvePublicTarget(hostname) {
  if (!hostname || hostname.length > 253) throw new Error("invalid_host");
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("private_target");
  const literal = net.isIP(hostname);
  if (literal) {
    if (isPrivateIp(hostname)) throw new Error("private_target");
    return hostname;
  }
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!rows.length) throw new Error("dns_not_found");
  const publicRows = rows.filter(r => !isPrivateIp(r.address));
  if (!publicRows.length || publicRows.length !== rows.length) throw new Error("private_target");
  return publicRows[0].address;
}

function headerValue(headers, name) {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : String(v || "");
}

function inspectPinnedUrl(targetUrl, ip) {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === "https:";
    const client = isHttps ? https : http;
    const port = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);
    if (!([80,443,8080,8443].includes(port))) return reject(new Error("unsupported_port"));

    const options = {
      host: ip,
      port,
      method: "GET",
      path: targetUrl.pathname + targetUrl.search,
      headers: {
        "Host": targetUrl.host,
        "User-Agent": "Sahbi-Security-Lab/1.0",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Connection": "close",
      },
      timeout: 8000,
      rejectUnauthorized: false,
      servername: isHttps ? targetUrl.hostname : undefined,
    };

    const req = client.request(options, res => {
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= 131072) body += chunk;
      });
      res.on("end", () => {
        let tls = null;
        if (isHttps && res.socket && typeof res.socket.getPeerCertificate === "function") {
          const cert = res.socket.getPeerCertificate();
          const cipher = typeof res.socket.getCipher === "function" ? res.socket.getCipher() : null;
          tls = {
            authorized: Boolean(res.socket.authorized),
            authorizationError: res.socket.authorizationError || null,
            protocol: typeof res.socket.getProtocol === "function" ? res.socket.getProtocol() : null,
            cipher: cipher ? cipher.name : null,
            validFrom: cert && cert.valid_from || null,
            validTo: cert && cert.valid_to || null,
            subject: cert && cert.subject ? cert.subject.CN || null : null,
            issuer: cert && cert.issuer ? cert.issuer.CN || cert.issuer.O || null : null,
          };
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: body.slice(0, 131072),
          tls,
        });
      });
    });

    req.on("timeout", () => req.destroy(new Error("target_timeout")));
    req.on("error", reject);
    req.end();
  });
}

function securityFindings(url, result) {
  const h = result.headers || {};
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, title, detail });

  if (url.protocol !== "https:") add("high", "HTTPS absent", "La cible utilise HTTP. Les échanges peuvent être interceptés ou modifiés.");
  if (url.protocol === "https:" && result.tls) {
    if (!result.tls.authorized) add("high", "Certificat TLS non validé", result.tls.authorizationError || "La chaîne de confiance n'est pas validée.");
    if (result.tls.protocol && !/^TLSv1\.[23]$/i.test(result.tls.protocol)) add("medium", "Version TLS ancienne", "Protocole observé: " + result.tls.protocol);
    if (result.tls.validTo) {
      const days = Math.floor((new Date(result.tls.validTo).getTime() - Date.now()) / 86400000);
      if (Number.isFinite(days) && days < 30) add(days < 0 ? "high" : "medium", "Certificat proche de l'expiration", "Expiration dans environ " + days + " jour(s).");
    }
  }

  const securityHeaders = [
    ["strict-transport-security","HSTS","medium"],
    ["content-security-policy","Content-Security-Policy","medium"],
    ["x-content-type-options","X-Content-Type-Options","low"],
    ["referrer-policy","Referrer-Policy","low"],
    ["permissions-policy","Permissions-Policy","low"],
  ];
  for (const [key,label,sev] of securityHeaders) {
    if (!headerValue(h,key)) add(sev, label + " absent", "Header de sécurité non détecté.");
  }

  const xfo = headerValue(h,"x-frame-options");
  const csp = headerValue(h,"content-security-policy");
  if (!xfo && !/frame-ancestors/i.test(csp)) add("medium", "Protection anti-clickjacking absente", "Ni X-Frame-Options ni frame-ancestors n'ont été détectés.");

  const server = headerValue(h,"server");
  const powered = headerValue(h,"x-powered-by");
  if (server) add("info", "Header Server exposé", server);
  if (powered) add("low", "X-Powered-By exposé", powered);

  const acao = headerValue(h,"access-control-allow-origin");
  const acac = headerValue(h,"access-control-allow-credentials");
  if (acao === "*" && acac.toLowerCase() === "true") add("high", "CORS incohérent", "Access-Control-Allow-Origin=* avec credentials=true.");
  else if (acao === "*") add("info", "CORS permissif", "Access-Control-Allow-Origin=* détecté.");

  const cookies = h["set-cookie"];
  const cookieRows = Array.isArray(cookies) ? cookies : cookies ? [String(cookies)] : [];
  for (const row of cookieRows.slice(0,10)) {
    const name = row.split("=")[0] || "cookie";
    if (!/;\s*secure/i.test(row) && url.protocol === "https:") add("medium", "Cookie sans Secure", name);
    if (!/;\s*httponly/i.test(row)) add("low", "Cookie sans HttpOnly", name);
    if (!/;\s*samesite=/i.test(row)) add("low", "Cookie sans SameSite", name);
  }

  const loc = headerValue(h,"location");
  if (result.status >= 300 && result.status < 400 && loc) add("info", "Redirection", "HTTP " + result.status + " vers " + loc);

  if (/<meta[^>]+http-equiv=["']?refresh/i.test(result.body || "")) add("info", "Meta refresh détecté", "La page contient une redirection côté HTML.");
  if (/http:\/\//i.test(result.body || "") && url.protocol === "https:") add("low", "Références HTTP détectées", "La page HTTPS contient au moins une référence http://; vérifier le contenu mixte.");

  return findings;
}

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/manifest.json", "manifest.json"],
  ["/builder.html", "builder.html"],
  ["/projects.html", "projects.html"],
  ["/sandbox.html", "sandbox.html"],
  ["/studio.html", "studio.html"],
  ["/plugins.html", "plugins.html"],
  ["/deploy.html", "deploy.html"],
  ["/security.html", "security.html"],
]);

function contentTypeFor(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function serveStatic(req, res, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return false;
  try {
    const full = path.join(process.cwd(), file);
    const body = await fs.readFile(full);
    res.writeHead(200, {
      "content-type": contentTypeFor(file),
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  } catch {
    res.writeHead(404, {"content-type":"text/plain; charset=utf-8","cache-control":"no-store"});
    res.end("Not found");
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && await serveStatic(req, res, url.pathname)) return;

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

  if (req.method === "POST" && url.pathname === "/api/build") {
    const owner = verifyOwnerToken(ownerTokenFrom(req));
    if (!owner) return json(res, 401, { error: "owner_required", message: "Mode Owner requis pour Build Lab." }, origin);

    const rate = consumeRate(req, true);
    if (!rate.ok) return json(res, 429, { error: "rate_limited", retryAfter: rate.retryAfter }, origin);

    try {
      const body = await readBody(req);
      const language = String(body.language || "").toLowerCase();
      const source = String(body.source || "");
      const stdin = String(body.stdin || "");

      const languageIds = {
        c: 103,
        cpp: 105,
        javascript: 102,
        python: 113,
        rust: 108,
        java: 91,
      };
      const languageId = languageIds[language];
      if (!languageId) return json(res, 400, { error: "unsupported_language" }, origin);
      if (!source || source.length > 30000) return json(res, 400, { error: "source_too_large", message: "Source limité à 30 000 caractères par build." }, origin);
      if (stdin.length > 4000) return json(res, 400, { error: "stdin_too_large" }, origin);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const endpoint = "https://ce.judge0.com/submissions?base64_encoded=false&wait=true";
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            language_id: languageId,
            source_code: source,
            stdin,
            cpu_time_limit: 5,
            wall_time_limit: 8,
            memory_limit: 262144,
            max_processes_and_or_threads: 32,
            enable_network: false,
          }),
          signal: controller.signal,
        });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) return json(res, 502, { error: "judge0_unavailable", message: "Build Lab indisponible.", detail: data?.error || null }, origin);

        return json(res, 200, {
          ok: Number(data?.status?.id) === 3,
          statusId: data?.status?.id ?? null,
          status: data?.status?.description || "Unknown",
          stdout: String(data?.stdout || "").slice(0, 8000),
          stderr: String(data?.stderr || "").slice(0, 8000),
          compileOutput: String(data?.compile_output || "").slice(0, 12000),
          message: String(data?.message || "").slice(0, 4000),
          exitCode: data?.exit_code ?? null,
          time: data?.time ?? null,
          memory: data?.memory ?? null,
          language,
          runner: "judge0",
        }, origin);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const timeout = error && error.name === "AbortError";
      return json(res, timeout ? 504 : 503, {
        error: timeout ? "build_timeout" : "build_error",
        message: timeout ? "Le build a dépassé le délai." : "Le Build Lab est momentanément indisponible."
      }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/security/check") {
    const owner = verifyOwnerToken(ownerTokenFrom(req));
    if (!owner) return json(res, 401, { error: "owner_required", message: "Mode Owner requis pour Security Lab." }, origin);

    const rate = consumeRate(req, true);
    if (!rate.ok) return json(res, 429, { error: "rate_limited", retryAfter: rate.retryAfter }, origin);

    try {
      const body = await readBody(req);
      if (body.authorized !== true) return json(res, 400, { error: "authorization_required", message: "Confirme que tu possèdes la cible ou que tu as une autorisation explicite." }, origin);
      let rawTarget = String(body.target || "").trim();
      if (!rawTarget) return json(res, 400, { error: "target_required" }, origin);
      if (!/^https?:\/\//i.test(rawTarget)) rawTarget = "https://" + rawTarget;
      const target = new URL(rawTarget);
      if (!["http:","https:"].includes(target.protocol)) return json(res, 400, { error: "unsupported_scheme" }, origin);
      if (target.username || target.password) return json(res, 400, { error: "credentials_in_url_not_allowed" }, origin);
      if (target.pathname.length > 1500 || target.search.length > 1500) return json(res, 400, { error: "target_too_long" }, origin);

      const ip = await resolvePublicTarget(target.hostname);
      const result = await inspectPinnedUrl(target, ip);
      const findings = securityFindings(target, result);

      return json(res, 200, {
        ok: true,
        target: target.origin + target.pathname,
        resolvedIp: ip,
        status: result.status,
        tls: result.tls,
        findings,
        summary: {
          high: findings.filter(x => x.severity === "high").length,
          medium: findings.filter(x => x.severity === "medium").length,
          low: findings.filter(x => x.severity === "low").length,
          info: findings.filter(x => x.severity === "info").length,
        },
      }, origin);
    } catch (error) {
      const msg = String(error && error.message || error);
      const safe = ["private_target","invalid_host","dns_not_found","unsupported_port","target_timeout"].includes(msg) ? msg : "scan_failed";
      return json(res, 400, { error: safe, message: safe === "private_target" ? "Les cibles locales/privées sont bloquées par ce scanner cloud." : "Impossible d'analyser cette cible." }, origin);
    }
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
      const raw = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
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

      const requestedMaxTokens = Math.max(1, Math.min(Number(body.max_tokens || 1000), owner ? 5000 : 3000));
      const messages = raw.map(m => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: String(m.content || "").slice(0, 10000),
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
