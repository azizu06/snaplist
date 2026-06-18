#!/usr/bin/env node
/**
 * eBay refresh-token helper — durable publishing auth (issues #14 / #17).
 *
 * A pasted `EBAY_OAUTH_TOKEN` is a USER ACCESS token (~2h). For ongoing publishing
 * the adapter (`EnvTokenProvider`) prefers a long-lived REFRESH token (~18 months
 * in sandbox) in `EBAY_REFRESH_TOKEN`, which it exchanges for access tokens
 * automatically. This helper gets you that refresh token and proves it works.
 *
 * Reads EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_RU_NAME / EBAY_BASE_URL from
 * .env.local. Three modes:
 *
 *   node scripts/ebay-refresh-token.mjs verify
 *       Exchange the stored EBAY_REFRESH_TOKEN for an access token (proves it's
 *       valid + correctly scoped). Run this after pasting the refresh token.
 *
 *   node scripts/ebay-refresh-token.mjs authurl
 *       Print the consent URL. Open it, sign in as the SANDBOX SELLER, accept,
 *       then copy the `code` query param from the redirect URL.
 *
 *   node scripts/ebay-refresh-token.mjs exchange "<CODE>"
 *       Exchange that authorization `code` for a refresh token and print it.
 *
 * EASIEST PATH (no consent dance): the eBay developer console "User Tokens" page —
 * the same one that gave you the access token — also shows a "Refresh Token" right
 * below it. Copy that into EBAY_REFRESH_TOKEN and just run `verify`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env.local", import.meta.url));
const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const BASE = env.EBAY_BASE_URL || "https://api.sandbox.ebay.com";
const AUTH_BASE = BASE.includes("sandbox") ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
const CLIENT_ID = env.EBAY_CLIENT_ID;
const CLIENT_SECRET = env.EBAY_CLIENT_SECRET;
const RU_NAME = env.EBAY_RU_NAME;

// Request the full publishing + account scopes so the resulting refresh token can
// both publish (sell.inventory) and re-create policies/location later (sell.account).
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];
const basicAuth = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

function need(...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing in .env.local: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function tokenCall(params) {
  const res = await fetch(`${BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const mode = process.argv[2];

if (mode === "authurl") {
  need("EBAY_CLIENT_ID", "EBAY_RU_NAME");
  const url = new URL(`${AUTH_BASE}/oauth2/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", RU_NAME); // eBay quirk: redirect_uri = the RuName, not a URL
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", "snaplist-mint");
  console.log("\nOpen this URL, sign in as the SANDBOX SELLER, and accept:\n");
  console.log(url.toString());
  console.log("\nThen copy the `code` param from the redirect URL and run:");
  console.log('  node scripts/ebay-refresh-token.mjs exchange "<CODE>"\n');
} else if (mode === "exchange") {
  need("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RU_NAME");
  const code = process.argv[3];
  if (!code) {
    console.error('Pass the code: node scripts/ebay-refresh-token.mjs exchange "<CODE>"');
    process.exit(1);
  }
  const { status, json } = await tokenCall({
    grant_type: "authorization_code",
    code: decodeURIComponent(code),
    redirect_uri: RU_NAME,
  });
  if (status !== 200 || !json.refresh_token) {
    console.error(`Exchange failed (${status}):`, JSON.stringify(json).slice(0, 400));
    process.exit(1);
  }
  console.log("\n✓ Refresh token (valid ~", json.refresh_token_expires_in, "s):\n");
  console.log("EBAY_REFRESH_TOKEN=" + json.refresh_token);
  console.log("\nPaste that into .env.local, clear EBAY_OAUTH_TOKEN, then run `verify`.\n");
} else if (mode === "verify") {
  need("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET");
  if (!env.EBAY_REFRESH_TOKEN) {
    console.error("EBAY_REFRESH_TOKEN is empty — paste it into .env.local first.");
    process.exit(1);
  }
  const { status, json } = await tokenCall({
    grant_type: "refresh_token",
    refresh_token: env.EBAY_REFRESH_TOKEN,
    scope: "https://api.ebay.com/oauth/api_scope/sell.inventory",
  });
  if (status !== 200 || !json.access_token) {
    console.error(`Verify FAILED (${status}):`, JSON.stringify(json).slice(0, 400));
    console.error("The refresh token is invalid/expired or lacks sell.inventory scope.");
    process.exit(1);
  }
  console.log(`✓ Refresh token works — minted an access token (len ${json.access_token.length}, expires in ${json.expires_in}s).`);
  console.log("  EnvTokenProvider will now auto-mint publishing tokens. Safe to clear EBAY_OAUTH_TOKEN.");
} else {
  console.log("Usage: node scripts/ebay-refresh-token.mjs <verify|authurl|exchange \"<CODE>\">");
  process.exit(1);
}
