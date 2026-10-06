/**
 * 5-Minute Bitcoin Up/Down Event Predictor & Paper Trading Engine
 * Modeled after event-predictor, specialized for Polymarket's btc-updown-5m contracts.
 * 
 * Commands:
 *   node predictor.js scan      # Discover active 5m markets & record paper trades
 *   node predictor.js resolve   # Resolve ended contracts & compute PnL
 *   node predictor.js report    # Statistical performance summary
 *   node predictor.js watch     # Continuous autonomous loop
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const POSITIONS_FILE = join(ROOT_DIR, "positions.json");
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const BINANCE = "https://api.binance.com/api/v3";
const DEFAULT_STAKE = 10.0;
const T = (ms) => AbortSignal.timeout(ms);

async function loadPositions() {
  try {
    const raw = await readFile(POSITIONS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function savePositions(positions) {
  await writeFile(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

let spotHistory = [];

// Fetch live BTC price + momentum across multiple robust sources
async function getBtcSpot() {
  let price = null;
  let source = "unknown";

  // 1. Read from polymarket-mac local live state (0ms latency, always fresh)
  try {
    const raw = await readFile("/data/data/com.termux/files/home/polymarket-mac/data/state/s.json", "utf8");
    const s = JSON.parse(raw);
    const px = s.spot?.["BTCUSDT"];
    if (Number.isFinite(px) && px > 0) {
      price = px;
      source = "local_feed";
    }
  } catch {}

  // 2. CoinGecko REST
  if (!price) {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: T(3500)
      });
      if (r.ok) {
        const d = await r.json();
        const px = d.bitcoin?.usd;
        if (Number.isFinite(px)) { price = px; source = "coingecko"; }
      }
    } catch {}
  }

  // 3. MEXC REST
  if (!price) {
    try {
      const r = await fetch("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT", { signal: T(3500) });
      if (r.ok) {
        const d = await r.json();
        const px = parseFloat(d.price);
        if (Number.isFinite(px)) { price = px; source = "mexc"; }
      }
    } catch {}
  }

  if (!price) return null;

  const now = Date.now();
  spotHistory.push({ price, ts: now });
  spotHistory = spotHistory.filter(h => now - h.ts <= 300000); // keep last 5 mins

  // Momentum = current price - price 2-3 mins ago (or oldest in window)
  const oldest = spotHistory[0];
  const momentum = oldest ? (price - oldest.price) : 0;

  return { price, momentum, source };
}

// Fetch active 5m BTC markets from Gamma API
async function getActive5mMarkets() {
  const now = Date.now() / 1000;
  const minISO = new Date((now - 600) * 1000).toISOString();
  const maxISO = new Date((now + 1800) * 1000).toISOString();
  try {
    const r = await fetch(`${GAMMA}/events?active=true&closed=false&limit=25&end_date_min=${encodeURIComponent(minISO)}&end_date_max=${encodeURIComponent(maxISO)}&order=endDate&ascending=true`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: T(8000)
    });
    if (!r.ok) return [];
    const evs = await r.json();
    const list = [];
    for (const e of evs) {
      if (!e.slug || !e.slug.includes("btc-updown-5m")) continue;
      const m = (e.markets || [])[0];
      if (!m) continue;
      let tokens = [];
      try { tokens = JSON.parse(m.clobTokenIds || "[]"); } catch {}
      if (tokens.length < 2) continue;
      let end = 0;
      try { end = Math.floor(new Date(e.endDate).getTime() / 1000); } catch {}
      if (!end) continue;
      list.push({
        eventSlug: e.slug,
        marketSlug: m.slug || e.slug,
        title: e.title || m.question,
        end,
        upToken: tokens[0],
        downToken: tokens[1]
      });
    }
    return list;
  } catch (err) {
    console.error("[gamma] error:", err.message);
    return [];
  }
}

// Get orderbook prices for a token
async function getBook(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: T(4000)
    });
    if (!r.ok) return null;
    const b = await r.json();
    const bestBid = b.bids && b.bids.length ? Math.max(...b.bids.map(x => parseFloat(x.price))) : null;
    const bestAsk = b.asks && b.asks.length ? Math.min(...b.asks.map(x => parseFloat(x.price))) : null;
    return { bestBid, bestAsk };
  } catch {
    return null;
  }
}

// ---------------- COMMAND: SCAN ----------------
export async function scan() {
  const spot = await getBtcSpot();
  if (!spot) {
    console.log("[scan] Failed to fetch BTC spot price");
    return;
  }
  const markets = await getActive5mMarkets();
  console.log(`[scan] BTC Spot: $${spot.price.toFixed(2)} (3m drift: ${spot.momentum > 0 ? "+" : ""}${spot.momentum.toFixed(2)}) | Found ${markets.length} 5m markets`);

  const positions = await loadPositions();
  const existingIds = new Set(positions.map(p => p.id));
  const now = Date.now() / 1000;

  for (const m of markets) {
    const timeLeft = m.end - now;
    // We scan contracts that have 60 to 240 seconds remaining
    if (timeLeft < 45 || timeLeft > 270) continue;

    // Check books for UP and DOWN
    const [bookUp, bookDown] = await Promise.all([
      getBook(m.upToken),
      getBook(m.downToken)
    ]);

    const upAsk = bookUp?.bestAsk || null;
    const downAsk = bookDown?.bestAsk || null;

    // Edge logic:
    // If momentum is positive (> +$15 over 3m) and UP ask is <= 0.60, buying UP has positive edge
    // If momentum is negative (< -$15 over 3m) and DOWN ask is <= 0.60, buying DOWN has positive edge
    let chosenSide = null;
    let chosenToken = null;
    let entryPrice = null;

    if (spot.momentum >= 15 && upAsk && upAsk <= 0.62 && upAsk >= 0.25) {
      chosenSide = "UP";
      chosenToken = m.upToken;
      entryPrice = upAsk;
    } else if (spot.momentum <= -15 && downAsk && downAsk <= 0.62 && downAsk >= 0.25) {
      chosenSide = "DOWN";
      chosenToken = m.downToken;
      entryPrice = downAsk;
    }

    if (!chosenSide) continue;

    const id = `${m.eventSlug}_${chosenSide}`;
    if (existingIds.has(id)) continue;

    const shares = Number((DEFAULT_STAKE / entryPrice).toFixed(2));
    const position = {
      id,
      slug: m.marketSlug,
      event: m.eventSlug,
      title: m.title,
      coin: "bitcoin",
      timeframe: "5m",
      side: chosenSide,
      token_id: chosenToken,
      entry_price: entryPrice,
      spot_at_entry: spot.price,
      momentum_at_entry: spot.momentum,
      stake: DEFAULT_STAKE,
      shares,
      created_at: Math.floor(now),
      end: m.end,
      resolved: false,
      won: null,
      pnl: null
    };

    positions.push(position);
    existingIds.add(id);
    console.log(`🎯 [PAPER ENTRY] ${m.title} | Side: ${chosenSide} @ ${entryPrice.toFixed(3)} | Spot: $${spot.price.toFixed(2)} | Exp in ${Math.round(timeLeft)}s`);
  }

  await savePositions(positions);
}

// ---------------- COMMAND: RESOLVE ----------------
export async function resolve() {
  const positions = await loadPositions();
  const unres = positions.filter(p => !p.resolved);
  if (!unres.length) {
    console.log("[resolve] No open positions to resolve");
    return;
  }

  const now = Date.now() / 1000;
  let resolvedCount = 0;

  for (const p of unres) {
    if (now < p.end + 15) continue; // wait 15s after close for oracle settlement

    try {
      const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(p.event)}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: T(6000)
      });
      if (!r.ok) continue;
      const evs = await r.json();
      const m = evs[0]?.markets?.[0];
      if (!m) continue;

      let won = null;
      // Check definitive outcomePrices: ["1", "0"] (UP) or ["0", "1"] (DOWN)
      let prices = [];
      try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
      if (prices.length >= 2) {
        const upPx = parseFloat(prices[0]);
        const downPx = parseFloat(prices[1]);
        if (upPx >= 0.95) won = (p.side === "UP");
        else if (downPx >= 0.95) won = (p.side === "DOWN");
      }

      if (won === null && m.closed) {
        // Fallback: compare resolution or last trade
        const upPx = parseFloat(prices[0] || "0.5");
        if (upPx > 0.5) won = (p.side === "UP");
        else won = (p.side === "DOWN");
      }

      if (won !== null) {
        p.resolved = true;
        p.won = won;
        if (won) {
          p.pnl = Number((p.shares * (1.0 - p.entry_price) - 0.02 * p.stake).toFixed(2));
          console.log(`✅ [WIN] ${p.title} | ${p.side} WON! PnL: +$${p.pnl.toFixed(2)}`);
        } else {
          p.pnl = Number((-p.stake).toFixed(2));
          console.log(`❌ [LOSS] ${p.title} | ${p.side} LOST. PnL: -$${p.stake.toFixed(2)}`);
        }
        resolvedCount++;
      }
    } catch (e) {
      console.error(`[resolve] error on ${p.slug}:`, e.message);
    }
  }

  if (resolvedCount > 0) {
    await savePositions(positions);
    console.log(`[resolve] Resolved ${resolvedCount} positions`);
  }
}

// ---------------- COMMAND: REPORT ----------------
export async function report() {
  const positions = await loadPositions();
  const resolved = positions.filter(p => p.resolved);
  const open = positions.filter(p => !p.resolved);

  const wins = resolved.filter(p => p.won).length;
  const losses = resolved.filter(p => !p.won).length;
  const winRate = resolved.length ? ((wins / resolved.length) * 100).toFixed(1) : "0.0";
  const totalPnl = resolved.reduce((acc, p) => acc + (p.pnl || 0), 0);

  console.log("\n==============================================");
  console.log("       PREDICT 5M - PERFORMANCE REPORT        ");
  console.log("==============================================");
  console.log(`Total Positions: ${positions.length}`);
  console.log(`Open Positions:  ${open.length}`);
  console.log(`Resolved:        ${resolved.length}`);
  console.log(`Wins / Losses:   ${wins} / ${losses}`);
  console.log(`Win Rate:        ${winRate}%`);
  console.log(`Total Paper PnL: ${totalPnl >= 0 ? "+$" : "-$"}${Math.abs(totalPnl).toFixed(2)}`);
  console.log("==============================================\n");
}

// ---------------- COMMAND: WATCH ----------------
export async function watch() {
  console.log("[predict-5m] Autonomous watch loop started (checking every 30s)...");
  const cycle = async () => {
    try {
      await scan();
      await resolve();
    } catch (e) {
      console.error("[cycle err]", e.message);
    }
  };
  await cycle();
  setInterval(cycle, 30000);
}

// CLI router
const cmd = process.argv[2] || "scan";
if (cmd === "scan") scan();
else if (cmd === "resolve") resolve();
else if (cmd === "report") report();
else if (cmd === "watch") watch();
