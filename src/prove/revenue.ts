/**
 * Stripe revenue sync (PRD-B §2.5).
 *
 * Reads real charges through the read-only restricted key organizers were given
 * (Balance=Read, Charges=Read) and rolls them into AdLayerState.revenue. The key
 * is an `rk_` — never an `sk_`; this module only ever GETs.
 *
 * No key set → "not configured": zeroes with `stripe_synced_at: null`. This is
 * never a fabricated charge, and the app still renders from committed state.
 *
 * Run via tsx: `npm run revenue` (add `--write` to merge into web/data/state.json).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AdLayerState } from "../contract.ts";

const STRIPE_API = "https://api.stripe.com/v1";

export interface RevenueSummary {
  total_cents: number;
  transaction_count: number;
  stripe_synced_at: string | null;
  /** Present only when there is no key — a clear, non-fabricated signal. */
  configured: boolean;
}

interface StripeCharge {
  amount: number;
  amount_captured?: number;
  amount_refunded?: number;
  currency: string;
  paid: boolean;
  status: string;
}

interface ChargeList {
  data: StripeCharge[];
  has_more: boolean;
}

/** Page through /charges with the restricted key. Read-only. */
async function fetchAllCharges(key: string): Promise<StripeCharge[]> {
  const charges: StripeCharge[] = [];
  let startingAfter: string | undefined;
  // Stripe charge objects also carry an `id`; we only need it for pagination.
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${STRIPE_API}/charges`);
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Stripe /charges HTTP ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as ChargeList & { data: (StripeCharge & { id: string })[] };
    charges.push(...body.data);
    if (!body.has_more || body.data.length === 0) break;
    startingAfter = body.data[body.data.length - 1]!.id;
  }
  return charges;
}

/** Net captured revenue (captured minus refunded) over succeeded, paid charges. */
export function computeRevenue(charges: StripeCharge[], nowIso: string): RevenueSummary {
  let total = 0;
  let count = 0;
  for (const c of charges) {
    if (c.status !== "succeeded" || !c.paid) continue;
    const captured = c.amount_captured ?? c.amount;
    const net = captured - (c.amount_refunded ?? 0);
    if (net <= 0) continue;
    total += net;
    count += 1;
  }
  return { total_cents: total, transaction_count: count, stripe_synced_at: nowIso, configured: true };
}

/** Sync revenue from Stripe, or return the not-configured summary when no key is set. */
export async function syncRevenue(now: () => string = () => new Date().toISOString()): Promise<RevenueSummary> {
  const key = process.env.STRIPE_RESTRICTED_KEY?.trim();
  if (!key) {
    return { total_cents: 0, transaction_count: 0, stripe_synced_at: null, configured: false };
  }
  if (!key.startsWith("rk_")) {
    throw new Error("Refusing to use a non-restricted Stripe key. Only an rk_ key belongs here.");
  }
  const charges = await fetchAllCharges(key);
  return computeRevenue(charges, now());
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo runner — `npm run revenue` (add --write to update web/data/state.json)
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, "..", "..", "web", "data", "state.json");

async function main(): Promise<void> {
  const summary = await syncRevenue();
  if (!summary.configured) {
    console.log("[revenue] not configured — set STRIPE_RESTRICTED_KEY (rk_…) to sync real charges.");
    return;
  }
  console.log(
    `[revenue] $${(summary.total_cents / 100).toFixed(2)} across ${summary.transaction_count} ` +
      `charge(s) · synced ${summary.stripe_synced_at}`,
  );

  if (process.argv.includes("--write")) {
    try {
      const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as AdLayerState & Record<string, unknown>;
      state.revenue = {
        total_cents: summary.total_cents,
        transaction_count: summary.transaction_count,
        stripe_synced_at: summary.stripe_synced_at,
      };
      await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
      console.log(`[revenue] wrote revenue into ${STATE_PATH}`);
    } catch (err) {
      console.error("[revenue] could not update state.json:", err);
      process.exitCode = 1;
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[revenue] sync failed:", err);
    process.exitCode = 1;
  });
}
