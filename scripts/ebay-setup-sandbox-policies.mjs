#!/usr/bin/env node
/**
 * One-shot eBay Sell-account setup for the sandbox seller (issue #14 / #17 prep).
 *
 * Publishing an offer (`HttpEbayAdapter.publishListing`) requires three business
 * policies + a merchant location on the seller's account. These IDs are PERMANENT
 * once created (unlike the ~2h user access token), so this is a one-time bootstrap
 * — run it once, paste the printed ids into `.env.local`, done.
 *
 * Auth: reads the current `EBAY_OAUTH_TOKEN` (a user access token with the
 * `sell.account` + `sell.inventory` scopes) from `.env.local`. Mint a fresh one in
 * the eBay developer console if it has expired (errorId 1001/invalid_token).
 *
 * Idempotent: opt-in is skipped if already done; a policy whose name already
 * exists is reused (not duplicated); the location PUT is an upsert. Safe to re-run.
 *
 * Sandbox→production: this same script works against production by flipping
 * EBAY_BASE_URL + the token in `.env.local`. The defaults below (free USPS
 * shipping, 2-day handling, 30-day money-back returns) are sane showcase values;
 * edit them in Seller Hub or here as needed.
 *
 * Usage:  node scripts/ebay-setup-sandbox-policies.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env.local", import.meta.url));

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    out[t.slice(0, t.indexOf("=")).trim()] = t.slice(t.indexOf("=") + 1).trim();
  }
  return out;
}

const env = loadEnv(ENV_PATH);
const BASE = env.EBAY_BASE_URL || "https://api.sandbox.ebay.com";
const MARKET = env.EBAY_MARKETPLACE_ID || "EBAY_US";
const TOKEN = env.EBAY_OAUTH_TOKEN;
const CURRENCY = env.EBAY_CURRENCY || "USD";

if (!TOKEN) {
  console.error("Missing EBAY_OAUTH_TOKEN in .env.local — paste a fresh user token first.");
  process.exit(1);
}

const CATEGORY = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "accept-language": "en-US",
      "content-language": env.EBAY_CONTENT_LANGUAGE || "en-US",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, location: res.headers.get("location") };
}

function errId(json) {
  return json?.errors?.[0]?.errorId;
}

/** POST a create-policy; on duplicate-name, fall back to the existing policy id. */
async function ensurePolicy(kind, idField, listKey, createBody) {
  const create = await api("POST", `/sell/account/v1/${kind}`, createBody);
  if (create.status === 201 || create.status === 200) {
    const id = create.json?.[idField] || create.location?.split("/").pop();
    console.log(`  ✓ created ${kind}: ${id}`);
    return id;
  }
  // 20400 = name already exists → reuse it (idempotent re-run).
  const list = await api("GET", `/sell/account/v1/${kind}?marketplace_id=${MARKET}`);
  const existing = (list.json?.[listKey] || []).find((p) => p.name === createBody.name);
  if (existing) {
    const id = existing[idField];
    console.log(`  ✓ reused ${kind}: ${id} (already existed)`);
    return id;
  }
  console.error(`  ✗ ${kind} failed (${create.status}):`, JSON.stringify(create.json).slice(0, 300));
  return null;
}

async function main() {
  console.log(`eBay account setup → ${BASE} (${MARKET})\n`);

  // 1. Opt the seller into Business Policies (required before policy creation).
  const opted = await api("GET", "/sell/account/v1/program/get_opted_in_programs");
  const has = (opted.json?.programs || []).some((p) => p.programType === "SELLING_POLICY_MANAGEMENT");
  if (has) {
    console.log("• Business Policies: already opted in");
  } else {
    const optIn = await api("POST", "/sell/account/v1/program/opt_in", {
      programType: "SELLING_POLICY_MANAGEMENT",
    });
    if (optIn.status >= 200 && optIn.status < 300) {
      console.log("• Business Policies: opted in ✓");
    } else {
      console.error("• Opt-in FAILED:", optIn.status, JSON.stringify(optIn.json).slice(0, 300));
      console.error("  The sandbox seller may need more onboarding in Seller Hub. Stopping.");
      process.exit(1);
    }
  }

  // 2. Three business policies.
  console.log("\n• Policies:");
  const fulfillmentId = await ensurePolicy("fulfillment_policy", "fulfillmentPolicyId", "fulfillmentPolicies", {
    name: "SnapList Standard Shipping",
    marketplaceId: MARKET,
    categoryTypes: CATEGORY,
    handlingTime: { value: 2, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [
          {
            sortOrder: 1,
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSPriority",
            shippingCost: { value: "0.00", currency: CURRENCY },
            freeShipping: true,
          },
        ],
      },
    ],
  });

  const paymentId = await ensurePolicy("payment_policy", "paymentPolicyId", "paymentPolicies", {
    name: "SnapList Immediate Pay",
    marketplaceId: MARKET,
    categoryTypes: CATEGORY,
    immediatePay: true,
  });

  const returnId = await ensurePolicy("return_policy", "returnPolicyId", "returnPolicies", {
    name: "SnapList 30-Day Returns",
    marketplaceId: MARKET,
    categoryTypes: CATEGORY,
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: "DAY" },
    refundMethod: "MONEY_BACK",
    returnShippingCostPayer: "BUYER",
  });

  // 3. Merchant location (PUT is an upsert keyed by the merchantLocationKey).
  console.log("\n• Location:");
  const locKey = "snaplist-sandbox-1";
  const loc = await api("PUT", `/sell/inventory/v1/location/${locKey}`, {
    location: {
      address: {
        addressLine1: "1 Market Street",
        city: "San Francisco",
        stateOrProvince: "CA",
        postalCode: "94105",
        country: "US",
      },
    },
    name: "SnapList Sandbox Location",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
  });
  let locationKey = null;
  if (loc.status === 204 || loc.status === 200) {
    locationKey = locKey;
    console.log(`  ✓ location ready: ${locKey}`);
  } else if (errId(loc.json) === 25803 || /already exists/i.test(JSON.stringify(loc.json))) {
    locationKey = locKey;
    console.log(`  ✓ location reused: ${locKey}`);
  } else {
    console.error(`  ✗ location failed (${loc.status}):`, JSON.stringify(loc.json).slice(0, 300));
  }

  // 4. Print the env block to paste.
  console.log("\n──────── paste into .env.local ────────");
  console.log(`EBAY_FULFILLMENT_POLICY_ID=${fulfillmentId ?? ""}`);
  console.log(`EBAY_PAYMENT_POLICY_ID=${paymentId ?? ""}`);
  console.log(`EBAY_RETURN_POLICY_ID=${returnId ?? ""}`);
  console.log(`EBAY_MERCHANT_LOCATION_KEY=${locationKey ?? ""}`);
  console.log("───────────────────────────────────────");

  if (!fulfillmentId || !paymentId || !returnId || !locationKey) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
