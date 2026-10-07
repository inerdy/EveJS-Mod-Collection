"use strict";

const DISCORD_WEBHOOK_TIMEOUT_MS = 10000;

function isConfigured(webhookUrl) {
  return /^https:\/\/discord(?:app)?\.com\/api\/webhooks\//i.test(
    String(webhookUrl || "").trim(),
  );
}

async function sendWebhook(webhookUrl, content) {
  const url = String(webhookUrl || "").trim();
  if (!isConfigured(url)) return {sent: false, skipped: true};
  if (typeof fetch !== "function") {
    throw new Error("Node.js fetch is unavailable");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      username: "NPC Market Liquidity",
      content: String(content || "").slice(0, 1900),
      allowed_mentions: {parse: []},
    }),
    signal: AbortSignal.timeout(DISCORD_WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
  }
  return {sent: true, status: response.status};
}

module.exports = {isConfigured, sendWebhook};
