/**
 * Server-side CoinMarketCap quotes. The key is read from CMC_API_KEY and sent
 * only on this request. Callers get prices and the 24-hour change.
 */

const ORIGIN = "https://pro-api.coinmarketcap.com";

export class CmcError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = "CmcError";
  }
}

export interface ShareQuote {
  symbol: string;
  name: string;
  priceUsd: number | null;
  /** 24-hour change of the most active tokenized wrapper, in percent. */
  percentChange24h: number | null;
}

export interface CmcQuoteResult {
  quotes: ShareQuote[];
  credits: number;
}

interface CmcStatus {
  error_code?: number | string;
  error_message?: string | null;
  credit_count?: number | string;
}

interface TokenRow {
  crypto_id?: number;
  price?: number;
  volume_24h?: number;
}

interface AssetRow {
  symbol?: string;
  name?: string;
  average_tokenized_price?: number;
  tokens?: TokenRow[];
}

interface QuoteCurrency {
  symbol?: string;
  percent_change_24h?: number;
}

interface CryptoQuoteRow {
  id?: number;
  quote?: { USD?: QuoteCurrency } | QuoteCurrency[];
}

type FetchLike = typeof fetch;

function redact(message: string): string {
  const secret = process.env.CMC_API_KEY?.trim();
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function apiKey(): string {
  const value = process.env.CMC_API_KEY?.trim();
  if (!value) throw new CmcError("CMC_API_KEY is not set.");
  return value;
}

async function getJson(path: string, fetchImpl: FetchLike): Promise<{ body: unknown; credits: number }> {
  let response: Response;
  try {
    response = await fetchImpl(`${ORIGIN}${path}`, {
      headers: {
        Accept: "application/json",
        "X-CMC_PRO_API_KEY": apiKey(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    throw new CmcError(message);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new CmcError(`CoinMarketCap returned HTTP ${response.status}.`);
  }
  const status = (body as { status?: CmcStatus }).status;
  const credits = Number(status?.credit_count ?? 0);
  const endpoint = path.split("?")[0];
  console.info(`cmc ${endpoint} credits=${credits} http=${response.status}`);
  if (!response.ok || Number(status?.error_code ?? 0) !== 0) {
    const message = status?.error_message?.trim() || `CoinMarketCap returned HTTP ${response.status}.`;
    throw new CmcError(message);
  }
  return { body, credits };
}

function assetsOf(body: unknown): AssetRow[] {
  const rows = (body as { data?: { rwa_assets?: AssetRow[] } }).data?.rwa_assets;
  return Array.isArray(rows) ? rows : [];
}

function activeToken(asset: AssetRow): TokenRow | undefined {
  const tokens = asset.tokens ?? [];
  return tokens.reduce<TokenRow | undefined>((best, token) => {
    if (!best) return token;
    return (token.volume_24h ?? 0) > (best.volume_24h ?? 0) ? token : best;
  }, undefined);
}

function changeFromRow(row: CryptoQuoteRow): number | undefined {
  const quote = row.quote;
  if (Array.isArray(quote)) {
    const usd = quote.find((item) => item.symbol === "USD") ?? quote[0];
    return typeof usd?.percent_change_24h === "number" ? usd.percent_change_24h : undefined;
  }
  const change = quote?.USD?.percent_change_24h;
  return typeof change === "number" ? change : undefined;
}

function changesOf(body: unknown): Map<number, number> {
  const data = (body as { data?: CryptoQuoteRow[] | Record<string, CryptoQuoteRow> }).data;
  const rows = Array.isArray(data)
    ? data
    : Object.entries(data ?? {}).map(([id, row]) => ({ ...row, id: row.id ?? Number(id) }));
  const changes = new Map<number, number>();
  for (const row of rows) {
    const change = changeFromRow(row);
    if (typeof row.id === "number" && typeof change === "number") changes.set(row.id, change);
  }
  return changes;
}

/** Latest dollar price and 24-hour change for each real-world asset symbol. */
export async function quoteShares(symbols: string[], fetchImpl: FetchLike = fetch): Promise<CmcQuoteResult> {
  const list = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) throw new CmcError("No symbols to quote.");

  const quoted = await getJson(
    `/v5/real-world-assets/quotes/latest?symbol=${encodeURIComponent(list.join(","))}&convert=USD`,
    fetchImpl,
  );
  const assets = assetsOf(quoted.body);
  const ids = [
    ...new Set(
      assets
        .map((asset) => activeToken(asset)?.crypto_id)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];

  let changes = new Map<number, number>();
  let credits = quoted.credits;
  if (ids.length > 0) {
    const tokens = await getJson(
      `/v3/cryptocurrency/quotes/latest?id=${ids.join(",")}&convert=USD`,
      fetchImpl,
    );
    changes = changesOf(tokens.body);
    credits += tokens.credits;
  }

  const quotes = assets.map((asset) => {
    const token = activeToken(asset);
    const cryptoId = token?.crypto_id;
    return {
      symbol: asset.symbol ?? "",
      name: asset.name ?? "",
      priceUsd: typeof asset.average_tokenized_price === "number" ? asset.average_tokenized_price : token?.price ?? null,
      percentChange24h: typeof cryptoId === "number" ? changes.get(cryptoId) ?? null : null,
    };
  });
  return { quotes, credits };
}

export interface MarketComparison {
  /** Cournot probability that the share's down claim happens, from 0 to 1. */
  cournotProbability: number;
  /** CMC Fear and Greed, from 0 to 100. Under 50 is the down-leaning market reading. */
  fearGreed: number;
  classification: string;
  updatedAt: string;
  /** True when both readings lean down, or both lean the other way. */
  agrees: boolean;
  credits: number;
}

/** Both readings lean down, or both lean up. A Cournot probability above one half leans down. */
export function readingsAgree(cournotProbability: number, fearGreed: number): boolean {
  if (cournotProbability < 0 || cournotProbability > 1 || fearGreed < 0 || fearGreed > 100) {
    throw new CmcError("Comparison readings are out of range.");
  }
  return cournotProbability > 0.5 === fearGreed < 50;
}

/** Place one Cournot probability next to the latest CMC Fear and Greed reading. */
export async function compareWithFearAndGreed(
  cournotProbability: number,
  fetchImpl: FetchLike = fetch,
): Promise<MarketComparison> {
  const quoted = await getJson("/v3/fear-and-greed/latest", fetchImpl);
  const data = (quoted.body as { data?: { value?: number | string; value_classification?: string; update_time?: string } }).data;
  const fearGreed = Number(data?.value);
  if (!Number.isFinite(fearGreed)) throw new CmcError("Fear and Greed value was missing.");
  return {
    cournotProbability,
    fearGreed,
    classification: data?.value_classification ?? "",
    updatedAt: data?.update_time ?? "",
    agrees: readingsAgree(cournotProbability, fearGreed),
    credits: quoted.credits,
  };
}
