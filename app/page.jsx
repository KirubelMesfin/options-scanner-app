import React, { useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, TrendingUp, Newspaper, KeyRound, ShieldAlert, ChevronRight, Activity, BarChart3 } from "lucide-react";

const API_BASE = "https://api.polygon.io";
const DEFAULT_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "NFLX", "PLTR",
  "AVGO", "SMCI", "MU", "CRM", "UBER", "JPM", "XOM", "FCX", "COIN", "HIMS"
];
const ECON_KEYWORDS = [
  "inflation", "cpi", "pce", "ppi", "jobs", "payrolls", "unemployment", "fed", "fomc", "rates",
  "gdp", "treasury", "yield", "tariff", "retail sales", "consumer sentiment", "pmi"
];

function classNames(...vals) {
  return vals.filter(Boolean).join(" ");
}

function fmtNum(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtPct(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Number(value).toFixed(digits)}%`;
}

function fmtCompact(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDate(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function toYmd(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nearestFriday(daysOut = 35) {
  const d = addDays(new Date(), daysOut);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

async function polygonFetch(path, apiKey) {
  const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Polygon request failed: ${res.status}`);
  }
  return res.json();
}

function deriveBarsMetrics(results = []) {
  const closes = results.map((r) => r.c).filter((v) => Number.isFinite(v));
  const volumes = results.map((r) => r.v).filter((v) => Number.isFinite(v));
  if (!closes.length) return null;

  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? current;
  const sma = (n) => {
    const arr = closes.slice(-n);
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-20).length);
  const recentVol = volumes[volumes.length - 1] ?? avgVol20;
  const momentum20 = closes.length > 20 ? ((current - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : null;
  const dayChange = prev ? ((current - prev) / prev) * 100 : null;

  return {
    current,
    prev,
    sma20: sma(20),
    sma50: sma(50),
    avgVol20,
    recentVol,
    relVol: avgVol20 ? recentVol / avgVol20 : null,
    momentum20,
    dayChange,
  };
}

function scoreUnderlying(snapshot, metrics) {
  const price = snapshot?.ticker?.day?.c ?? snapshot?.ticker?.lastTrade?.p ?? metrics?.current;
  const dayVolume = snapshot?.ticker?.day?.v;
  const dayChangePct = snapshot?.ticker?.todaysChangePerc ?? metrics?.dayChange;
  const relVol = metrics?.relVol ?? 1;
  const above20 = metrics?.current && metrics?.sma20 ? metrics.current > metrics.sma20 : false;
  const above50 = metrics?.current && metrics?.sma50 ? metrics.current > metrics.sma50 : false;
  const momentum20 = metrics?.momentum20 ?? 0;

  let score = 0;
  score += above20 ? 18 : 0;
  score += above50 ? 14 : 0;
  score += Math.max(0, Math.min(20, (dayChangePct ?? 0) * 2));
  score += Math.max(0, Math.min(18, (momentum20 ?? 0) * 0.7));
  score += Math.max(0, Math.min(12, ((relVol ?? 1) - 1) * 14));
  score += dayVolume > 5_000_000 ? 10 : dayVolume > 1_000_000 ? 6 : 0;
  score += price >= 10 && price <= 500 ? 8 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreOptionContract(contract, underlyingPrice, daysToExpiry) {
  const details = contract?.details || {};
  const greeks = contract?.greeks || {};
  const day = contract?.day || {};
  const quote = contract?.last_quote || contract?.lastQuote || {};
  const oi = contract?.open_interest ?? contract?.openInterest ?? 0;
  const iv = contract?.implied_volatility ?? contract?.impliedVolatility ?? 0;
  const delta = Math.abs(greeks?.delta ?? 0);
  const strike = details?.strike_price ?? details?.strikePrice;
  const spread = quote?.ask && quote?.bid ? (quote.ask - quote.bid) / Math.max(0.01, ((quote.ask + quote.bid) / 2)) : 0.25;
  const moneyness = strike && underlyingPrice ? ((strike - underlyingPrice) / underlyingPrice) * 100 : 999;
  const volume = day?.volume ?? 0;

  let score = 0;
  if (delta >= 0.35 && delta <= 0.62) score += 24;
  else if (delta >= 0.25 && delta <= 0.7) score += 14;

  if (oi >= 1000) score += 18;
  else if (oi >= 300) score += 12;
  else if (oi >= 100) score += 6;

  if (volume >= 500) score += 14;
  else if (volume >= 100) score += 8;

  if (spread <= 0.06) score += 16;
  else if (spread <= 0.12) score += 10;
  else if (spread <= 0.2) score += 4;

  if (iv > 0 && iv <= 0.45) score += 12;
  else if (iv <= 0.7) score += 8;
  else if (iv <= 1.0) score += 4;

  if (moneyness >= -1 && moneyness <= 6) score += 10;
  else if (moneyness <= 10) score += 6;

  if (daysToExpiry >= 25 && daysToExpiry <= 75) score += 6;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function estimateSuccessProbability(underlyingScore, optionScore, newsBias = 0) {
  const raw = 38 + underlyingScore * 0.27 + optionScore * 0.22 + newsBias * 8;
  return Math.max(20, Math.min(79, Math.round(raw)));
}

function inferNewsBias(news = []) {
  const titles = news.map((n) => `${n.title || ""} ${n.description || n.summary || ""}`.toLowerCase());
  const positive = ["beats", "upgrade", "surge", "wins", "partnership", "approval", "raises", "strong", "growth"];
  const negative = ["misses", "downgrade", "probe", "lawsuit", "cuts", "weak", "warning", "delay", "recall"];
  let score = 0;
  titles.forEach((t) => {
    if (positive.some((w) => t.includes(w))) score += 1;
    if (negative.some((w) => t.includes(w))) score -= 1;
  });
  return Math.max(-1.5, Math.min(1.5, score / Math.max(1, news.length)));
}

function optionSynopsis({ ticker, horizonLabel, underlyingScore, optionScore, success, contract, underlyingPrice, newsBias }) {
  const strike = contract?.details?.strike_price ?? contract?.details?.strikePrice;
  const delta = contract?.greeks?.delta;
  const iv = contract?.implied_volatility ?? contract?.impliedVolatility;
  const oi = contract?.open_interest ?? contract?.openInterest;
  const spread = contract?.last_quote?.ask && contract?.last_quote?.bid
    ? ((contract.last_quote.ask - contract.last_quote.bid) / Math.max(0.01, (contract.last_quote.ask + contract.last_quote.bid) / 2)) * 100
    : null;

  const pros = [];
  const cons = [];

  if (underlyingScore >= 70) pros.push("the underlying trend and momentum are supportive");
  else if (underlyingScore >= 55) pros.push("the stock setup is decent but not elite");
  else cons.push("the underlying trend is not especially strong right now");

  if ((Math.abs(delta ?? 0) >= 0.35) && (Math.abs(delta ?? 0) <= 0.62)) pros.push("delta sits in a workable range for directional calls");
  else cons.push("delta is less ideal, which can make the contract either too sluggish or too speculative");

  if ((iv ?? 0) > 0.9) cons.push("implied volatility is elevated, so premium risk is high");
  else if ((iv ?? 0) > 0) pros.push("implied volatility is not extreme relative to many short dated momentum names");

  if ((oi ?? 0) >= 300) pros.push("open interest is respectable, which should help tradability");
  else cons.push("open interest is thin, so liquidity can be a problem");

  if ((spread ?? 99) > 12) cons.push("the bid ask spread is wide, which increases execution risk");

  if (newsBias > 0.2) pros.push("recent news flow leans supportive");
  if (newsBias < -0.2) cons.push("recent news flow adds headline risk");

  const stance = success >= 64 ? "Good candidate" : success >= 54 ? "Watchlist candidate" : "Weak candidate";

  return {
    stance,
    text: `${ticker} ${horizonLabel} call idea around the $${fmtNum(strike)} strike. ${stance}. This setup works best when the stock is near $${fmtNum(underlyingPrice)} and continues higher soon after entry. Good: ${pros.join(", ") || "the setup has some usable characteristics"}. Risk: ${cons.join(", ") || "headline risk and timing still matter"}.`,
  };
}

function pickBestCallForHorizon(chain, underlyingPrice, horizonDays) {
  const targetDate = nearestFriday(horizonDays);
  const targetYmd = toYmd(targetDate);
  const calls = (chain?.results || []).filter((c) => (c?.details?.contract_type || c?.details?.contractType) === "call");

  const filtered = calls
    .map((c) => {
      const exp = c?.details?.expiration_date ?? c?.details?.expirationDate;
      const dte = exp ? Math.ceil((new Date(exp).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
      const score = scoreOptionContract(c, underlyingPrice, dte);
      return { ...c, __dte: dte, __score: score, __exp: exp };
    })
    .filter((c) => c.__dte != null && c.__dte >= Math.max(18, horizonDays - 14) && c.__dte <= horizonDays + 21)
    .sort((a, b) => {
      const aDateGap = Math.abs(new Date(a.__exp) - new Date(targetYmd));
      const bDateGap = Math.abs(new Date(b.__exp) - new Date(targetYmd));
      if (b.__score !== a.__score) return b.__score - a.__score;
      return aDateGap - bDateGap;
    });

  return filtered[0] || null;
}

function LoadingCard({ label }) {
  return (
    <div className="animate-pulse rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 h-4 w-28 rounded bg-slate-200" />
      <div className="h-8 w-40 rounded bg-slate-200" />
      <div className="mt-4 h-3 w-full rounded bg-slate-100" />
      <div className="mt-2 h-3 w-5/6 rounded bg-slate-100" />
      <div className="sr-only">{label}</div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="rounded-2xl bg-slate-900 p-2 text-white">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
        {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
      </div>
    </div>
  );
}

export default function PolygonOptionsScannerApp() {
  const [apiKey, setApiKey] = useState(localStorage.getItem("polygon_api_key") || "");
  const [marketStatus, setMarketStatus] = useState(null);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [homeLoading, setHomeLoading] = useState(false);
  const [error, setError] = useState("");
  const [tickerInput, setTickerInput] = useState("NVDA");
  const [selectedTicker, setSelectedTicker] = useState("NVDA");
  const [scannerUniverse, setScannerUniverse] = useState(DEFAULT_UNIVERSE.join(", "));
  const [scannerResults, setScannerResults] = useState([]);
  const [tickerAnalysis, setTickerAnalysis] = useState(null);
  const [economicNews, setEconomicNews] = useState([]);
  const [macroCards, setMacroCards] = useState([]);

  useEffect(() => {
    localStorage.setItem("polygon_api_key", apiKey);
  }, [apiKey]);

  const delayedWarning = useMemo(() => {
    return "Polygon can provide real time or delayed data depending on your plan. This app surfaces live or delayed Polygon data as returned by your key and does not fake real time.";
  }, []);

  async function loadHome() {
    if (!apiKey) return;
    setHomeLoading(true);
    setError("");
    try {
      const [status, inflation, news] = await Promise.all([
        polygonFetch(`/v1/marketstatus/now`, apiKey),
        polygonFetch(`/fed/v1/inflation?limit=1&sort=date.desc`, apiKey).catch(() => ({ results: [] })),
        polygonFetch(`/v2/reference/news?limit=30&order=desc&sort=published_utc`, apiKey).catch(() => ({ results: [] })),
      ]);

      setMarketStatus(status);
      const latestInflation = inflation?.results?.[0];
      const filteredEconomicNews = (news?.results || []).filter((item) => {
        const text = `${item.title || ""} ${item.description || item.summary || ""}`.toLowerCase();
        return ECON_KEYWORDS.some((k) => text.includes(k));
      }).slice(0, 6);
      setEconomicNews(filteredEconomicNews);
      setMacroCards([
        {
          label: "Headline CPI YoY",
          value: latestInflation?.cpi_year_over_year != null ? fmtPct(latestInflation.cpi_year_over_year, 1) : "Unavailable",
          sub: latestInflation?.date || "Polygon Economy endpoint",
        },
        {
          label: "Core CPI",
          value: latestInflation?.cpi_core != null ? fmtNum(latestInflation.cpi_core, 2) : "Unavailable",
          sub: "Latest reported reading",
        },
        {
          label: "Market Session",
          value: status?.market || status?.exchanges?.nyse || "Unavailable",
          sub: status?.serverTime ? formatDate(status.serverTime) : "Current market status",
        },
      ]);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setHomeLoading(false);
    }
  }

  async function runScanner() {
    if (!apiKey) {
      setError("Enter your Polygon API key first.");
      return;
    }
    setScannerLoading(true);
    setError("");

    try {
      const tickers = scannerUniverse.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 25);
      const items = await Promise.all(tickers.map(async (ticker) => {
        try {
          const [snapshot, bars, news, chain] = await Promise.all([
            polygonFetch(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`, apiKey),
            polygonFetch(`/v2/aggs/ticker/${ticker}/range/1/day/${toYmd(addDays(new Date(), -90))}/${toYmd(new Date())}?adjusted=true&sort=asc&limit=120`, apiKey),
            polygonFetch(`/v2/reference/news?ticker=${ticker}&limit=6&order=desc&sort=published_utc`, apiKey).catch(() => ({ results: [] })),
            polygonFetch(`/v3/snapshot/options/${ticker}?limit=250&sort=expiration_date`, apiKey).catch(() => ({ results: [] })),
          ]);

          const metrics = deriveBarsMetrics(bars?.results || []);
          const underlyingScore = scoreUnderlying(snapshot, metrics);
          const underlyingPrice = snapshot?.ticker?.day?.c ?? snapshot?.ticker?.lastTrade?.p ?? metrics?.current;
          const newsBias = inferNewsBias(news?.results || []);
          const oneMonth = pickBestCallForHorizon(chain, underlyingPrice, 35);
          const twoMonth = pickBestCallForHorizon(chain, underlyingPrice, 65);
          const oneMonthSuccess = oneMonth ? estimateSuccessProbability(underlyingScore, oneMonth.__score, newsBias) : null;
          const twoMonthSuccess = twoMonth ? estimateSuccessProbability(underlyingScore, twoMonth.__score, newsBias) : null;

          return {
            ticker,
            price: underlyingPrice,
            dayChangePct: snapshot?.ticker?.todaysChangePerc ?? metrics?.dayChange,
            volume: snapshot?.ticker?.day?.v,
            relVol: metrics?.relVol,
            underlyingScore,
            newsBias,
            oneMonth,
            twoMonth,
            oneMonthSuccess,
            twoMonthSuccess,
            rationale: news?.results?.[0]?.title || "No fresh headline found",
          };
        } catch (innerErr) {
          return {
            ticker,
            error: innerErr.message,
          };
        }
      }));

      setScannerResults(items.filter((x) => !x.error).sort((a, b) => {
        const aScore = Math.max(a.oneMonthSuccess || 0, a.twoMonthSuccess || 0);
        const bScore = Math.max(b.oneMonthSuccess || 0, b.twoMonthSuccess || 0);
        return bScore - aScore;
      }));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setScannerLoading(false);
    }
  }

  async function analyzeTicker(ticker) {
    const clean = ticker.trim().toUpperCase();
    if (!clean) return;
    if (!apiKey) {
      setError("Enter your Polygon API key first.");
      return;
    }

    setSelectedTicker(clean);
    setSearchLoading(true);
    setError("");

    try {
      const [snapshot, details, bars, news, chain] = await Promise.all([
        polygonFetch(`/v2/snapshot/locale/us/markets/stocks/tickers/${clean}`, apiKey),
        polygonFetch(`/v3/reference/tickers/${clean}`, apiKey).catch(() => ({})),
        polygonFetch(`/v2/aggs/ticker/${clean}/range/1/day/${toYmd(addDays(new Date(), -120))}/${toYmd(new Date())}?adjusted=true&sort=asc&limit=180`, apiKey),
        polygonFetch(`/v2/reference/news?ticker=${clean}&limit=8&order=desc&sort=published_utc`, apiKey).catch(() => ({ results: [] })),
        polygonFetch(`/v3/snapshot/options/${clean}?limit=250&sort=expiration_date`, apiKey).catch(() => ({ results: [] })),
      ]);

      const metrics = deriveBarsMetrics(bars?.results || []);
      const underlyingScore = scoreUnderlying(snapshot, metrics);
      const underlyingPrice = snapshot?.ticker?.day?.c ?? snapshot?.ticker?.lastTrade?.p ?? metrics?.current;
      const newsBias = inferNewsBias(news?.results || []);
      const oneMonth = pickBestCallForHorizon(chain, underlyingPrice, 35);
      const twoMonth = pickBestCallForHorizon(chain, underlyingPrice, 65);
      const oneMonthSuccess = oneMonth ? estimateSuccessProbability(underlyingScore, oneMonth.__score, newsBias) : null;
      const twoMonthSuccess = twoMonth ? estimateSuccessProbability(underlyingScore, twoMonth.__score, newsBias) : null;

      setTickerAnalysis({
        ticker: clean,
        details: details?.results || {},
        snapshot,
        metrics,
        underlyingPrice,
        underlyingScore,
        news: news?.results || [],
        chainCount: chain?.results?.length || 0,
        oneMonth,
        twoMonth,
        oneMonthSuccess,
        twoMonthSuccess,
        oneMonthSynopsis: oneMonth ? optionSynopsis({ ticker: clean, horizonLabel: "1 month", underlyingScore, optionScore: oneMonth.__score, success: oneMonthSuccess, contract: oneMonth, underlyingPrice, newsBias }) : null,
        twoMonthSynopsis: twoMonth ? optionSynopsis({ ticker: clean, horizonLabel: "2 month", underlyingScore, optionScore: twoMonth.__score, success: twoMonthSuccess, contract: twoMonth, underlyingPrice, newsBias }) : null,
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSearchLoading(false);
    }
  }

  useEffect(() => {
    if (apiKey) {
      loadHome();
      analyzeTicker(selectedTicker);
      runScanner();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topIdeas = scannerResults.slice(0, 8);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 rounded-[28px] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700 p-6 text-white shadow-xl">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-100 ring-1 ring-white/20">
                <Activity className="h-3.5 w-3.5" /> Polygon powered options scanner
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Live call option ideas with Polygon market data</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 sm:text-base">
                Scan for 1 month and 2 month call candidates, review strike ideas, compare option quality, and monitor company specific headlines plus macro news that could move the market.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[420px]">
              {(homeLoading ? [{}, {}, {}] : macroCards).map((card, idx) => (
                <div key={idx} className="rounded-3xl border border-white/10 bg-white/10 p-4 backdrop-blur">
                  {homeLoading ? (
                    <div className="animate-pulse">
                      <div className="h-3 w-20 rounded bg-white/20" />
                      <div className="mt-3 h-7 w-24 rounded bg-white/20" />
                      <div className="mt-3 h-3 w-28 rounded bg-white/10" />
                    </div>
                  ) : (
                    <>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-300">{card.label}</div>
                      <div className="mt-2 text-2xl font-semibold">{card.value}</div>
                      <div className="mt-1 text-xs text-slate-300">{card.sub}</div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <SectionTitle icon={KeyRound} title="Connect Polygon" subtitle="Paste your key, then this app will pull directly from Polygon endpoints." />
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste Polygon API key"
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none ring-0 transition focus:border-slate-900"
              />
              <button
                onClick={loadHome}
                className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Refresh home
              </button>
              <button
                onClick={() => {
                  runScanner();
                  analyzeTicker(selectedTicker);
                }}
                className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
              >
                Refresh all
              </button>
            </div>
            <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{delayedWarning}</span>
              </div>
            </div>
            {error ? <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <SectionTitle icon={Search} title="Analyze any ticker" subtitle="Pull a fresh snapshot, option chain, and news for any stock you enter." />
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <input
                value={tickerInput}
                onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
                placeholder="Enter ticker like NVDA"
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none transition focus:border-slate-900"
              />
              <button
                onClick={() => analyzeTicker(tickerInput)}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                {searchLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Analyze
              </button>
            </div>
            <div className="mt-3 text-sm text-slate-500">Current selection: <span className="font-medium text-slate-900">{selectedTicker}</span></div>
          </div>
        </div>

        <div className="mb-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <SectionTitle icon={Newspaper} title="Biggest economic news today" subtitle="Pulled from Polygon news and filtered for macro catalysts that can move option pricing and broad sentiment." />
            <div className="space-y-3">
              {homeLoading ? (
                <>
                  <LoadingCard label="Economic news loading" />
                  <LoadingCard label="Economic news loading" />
                </>
              ) : economicNews.length ? economicNews.map((item, idx) => (
                <a key={idx} href={item.article_url || item.articleUrl || "#"} target="_blank" rel="noreferrer" className="block rounded-3xl border border-slate-200 p-4 transition hover:border-slate-300 hover:bg-slate-50">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{item.publisher?.name || "Source"}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{item.title}</div>
                  <div className="mt-2 line-clamp-2 text-sm text-slate-600">{item.description || item.summary || "No summary provided."}</div>
                  <div className="mt-3 text-xs text-slate-400">{item.published_utc ? new Date(item.published_utc).toLocaleString() : ""}</div>
                </a>
              )) : (
                <div className="rounded-3xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">No macro headlines matched the filter right now. Refresh later or broaden the keyword filter in the code.</div>
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <SectionTitle icon={TrendingUp} title="Best current 1 month and 2 month call ideas" subtitle="The scanner ranks names in your watch universe using price trend, momentum, relative volume, and option contract quality." />

            <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto]">
              <textarea
                value={scannerUniverse}
                onChange={(e) => setScannerUniverse(e.target.value.toUpperCase())}
                rows={3}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none transition focus:border-slate-900"
                placeholder="Comma separated ticker universe"
              />
              <button
                onClick={runScanner}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                {scannerLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
                Run scan
              </button>
            </div>

            <div className="space-y-3">
              {scannerLoading ? (
                <>
                  <LoadingCard label="Scanner loading" />
                  <LoadingCard label="Scanner loading" />
                  <LoadingCard label="Scanner loading" />
                </>
              ) : topIdeas.length ? topIdeas.map((row) => {
                const bestSuccess = Math.max(row.oneMonthSuccess || 0, row.twoMonthSuccess || 0);
                return (
                  <button
                    key={row.ticker}
                    onClick={() => {
                      setTickerInput(row.ticker);
                      analyzeTicker(row.ticker);
                    }}
                    className="w-full rounded-3xl border border-slate-200 p-4 text-left transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-3">
                          <div className="text-lg font-semibold text-slate-900">{row.ticker}</div>
                          <div className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">Score {bestSuccess}</div>
                        </div>
                        <div className="mt-1 text-sm text-slate-500">${fmtNum(row.price)} • day {fmtPct(row.dayChangePct)} • relative volume {fmtNum(row.relVol, 2)}x</div>
                      </div>
                      <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" />
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-400">1 month call</div>
                        <div className="mt-1 text-sm font-medium text-slate-900">
                          {row.oneMonth ? `$${fmtNum(row.oneMonth?.details?.strike_price ?? row.oneMonth?.details?.strikePrice)} strike • ${row.oneMonthSuccess}%` : "No clean contract found"}
                        </div>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-400">2 month call</div>
                        <div className="mt-1 text-sm font-medium text-slate-900">
                          {row.twoMonth ? `$${fmtNum(row.twoMonth?.details?.strike_price ?? row.twoMonth?.details?.strikePrice)} strike • ${row.twoMonthSuccess}%` : "No clean contract found"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 text-sm text-slate-600">Headline driver: {row.rationale}</div>
                  </button>
                );
              }) : (
                <div className="rounded-3xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">No scanner results yet. Add your Polygon API key and run the scan.</div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <SectionTitle icon={Activity} title={`${selectedTicker} deep dive`} subtitle="Snapshot, option ideas, and company specific news for the currently selected ticker." />

          {searchLoading || !tickerAnalysis ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <LoadingCard label="Ticker analysis loading" />
              <LoadingCard label="Ticker analysis loading" />
              <LoadingCard label="Ticker analysis loading" />
            </div>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-4">
                <div className="rounded-3xl border border-slate-200 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Price</div>
                  <div className="mt-2 text-3xl font-semibold text-slate-900">${fmtNum(tickerAnalysis.underlyingPrice)}</div>
                  <div className="mt-1 text-sm text-slate-500">Day change {fmtPct(tickerAnalysis.snapshot?.ticker?.todaysChangePerc ?? tickerAnalysis.metrics?.dayChange)}</div>
                </div>
                <div className="rounded-3xl border border-slate-200 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Underlying score</div>
                  <div className="mt-2 text-3xl font-semibold text-slate-900">{tickerAnalysis.underlyingScore}</div>
                  <div className="mt-1 text-sm text-slate-500">Momentum and trend quality</div>
                </div>
                <div className="rounded-3xl border border-slate-200 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Relative volume</div>
                  <div className="mt-2 text-3xl font-semibold text-slate-900">{fmtNum(tickerAnalysis.metrics?.relVol, 2)}x</div>
                  <div className="mt-1 text-sm text-slate-500">vs 20 day average</div>
                </div>
                <div className="rounded-3xl border border-slate-200 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Option chain loaded</div>
                  <div className="mt-2 text-3xl font-semibold text-slate-900">{fmtCompact(tickerAnalysis.chainCount)}</div>
                  <div className="mt-1 text-sm text-slate-500">Contracts returned by Polygon</div>
                </div>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr_0.9fr]">
                {[{
                  title: "1 month call idea",
                  contract: tickerAnalysis.oneMonth,
                  success: tickerAnalysis.oneMonthSuccess,
                  synopsis: tickerAnalysis.oneMonthSynopsis,
                }, {
                  title: "2 month call idea",
                  contract: tickerAnalysis.twoMonth,
                  success: tickerAnalysis.twoMonthSuccess,
                  synopsis: tickerAnalysis.twoMonthSynopsis,
                }].map((box) => {
                  const c = box.contract;
                  const d = c?.details || {};
                  const g = c?.greeks || {};
                  const q = c?.last_quote || c?.lastQuote || {};
                  const spreadPct = q?.ask && q?.bid ? ((q.ask - q.bid) / Math.max(0.01, ((q.ask + q.bid) / 2))) * 100 : null;
                  return (
                    <div key={box.title} className="rounded-3xl border border-slate-200 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{box.title}</div>
                          <div className="mt-1 text-xl font-semibold text-slate-900">
                            {c ? `${tickerAnalysis.ticker} $${fmtNum(d?.strike_price ?? d?.strikePrice)} Call` : "No clean contract found"}
                          </div>
                        </div>
                        {box.success ? <div className="rounded-full bg-slate-900 px-3 py-1 text-sm font-medium text-white">{box.success}%</div> : null}
                      </div>

                      {c ? (
                        <>
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">Expiration:</span> <span className="font-medium text-slate-900">{d?.expiration_date ?? d?.expirationDate}</span></div>
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">Strike:</span> <span className="font-medium text-slate-900">${fmtNum(d?.strike_price ?? d?.strikePrice)}</span></div>
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">Delta:</span> <span className="font-medium text-slate-900">{fmtNum(g?.delta, 2)}</span></div>
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">IV:</span> <span className="font-medium text-slate-900">{fmtPct((c?.implied_volatility ?? c?.impliedVolatility ?? 0) * 100, 0)}</span></div>
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">Open interest:</span> <span className="font-medium text-slate-900">{fmtCompact(c?.open_interest ?? c?.openInterest)}</span></div>
                            <div className="rounded-2xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">Bid ask spread:</span> <span className="font-medium text-slate-900">{spreadPct != null ? fmtPct(spreadPct, 1) : "Unavailable"}</span></div>
                          </div>
                          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">{box.synopsis?.text}</div>
                        </>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">Polygon returned no call contract in the target horizon with enough data to score confidently. This often happens with plan limitations, delayed data, or thin option chains.</div>
                      )}
                    </div>
                  );
                })}

                <div className="rounded-3xl border border-slate-200 p-5">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Current events for {tickerAnalysis.ticker}</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">News that could matter for the trade</div>
                  <div className="mt-4 space-y-3">
                    {tickerAnalysis.news.length ? tickerAnalysis.news.map((item, idx) => (
                      <a key={idx} href={item.article_url || item.articleUrl || "#"} target="_blank" rel="noreferrer" className="block rounded-2xl border border-slate-200 p-3 transition hover:bg-slate-50">
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-400">{item.publisher?.name || "Source"}</div>
                        <div className="mt-1 text-sm font-medium text-slate-900">{item.title}</div>
                        <div className="mt-1 line-clamp-2 text-sm text-slate-600">{item.description || item.summary || "No summary available."}</div>
                        <div className="mt-2 text-xs text-slate-400">{item.published_utc ? new Date(item.published_utc).toLocaleString() : ""}</div>
                      </a>
                    )) : (
                      <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">No recent ticker news returned.</div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
