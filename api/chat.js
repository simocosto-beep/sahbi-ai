import { generateText } from "ai";

const ALLOWED_ORIGIN = "https://simocosto-beep.github.io";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) return res.status(400).json({ error: "messages required" });

    const normalized = messages.map(m => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: String(m.content || "").slice(0, 24000)
    }));

    const result = await generateText({
      model: "zai/glm-5.3",
      messages: normalized,
      maxOutputTokens: 1800,
      temperature: 0.5
    });

    return res.status(200).json({ text: result.text || "" });
  } catch (error) {
    console.error("sahbi_api_error", error);
    return res.status(500).json({ error: "AI service unavailable" });
  }
}
