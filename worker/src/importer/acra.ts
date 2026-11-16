// ACRA "Entities Registered with ACRA" (data.gov.sg dataset d_3f960c10fed6145404ca7b821f263b87).
// Contract: docs/source-contracts.md. Download: initiate-download -> poll-download -> CSV URL.
// The poll status vocabulary, the download host and URL expiry are NOT verified yet, so this
// adapter never interprets status strings as success: success needs a URL on a verified host and a
// CSV that passes validation.

import { parse, type Options } from "csv-parse";
import { FetchRejected, Pacer, readSmallJson, safeGet, type FetchDeps } from "./fetchpolicy.ts";
import { RowError, type SourceRecord } from "./records.ts";
import { datePrecision, normalizeUen } from "../normalize.ts";

export const ACRA_DATASET_ID = "d_3f960c10fed6145404ca7b821f263b87";
export const ACRA_API_HOST = "api-open.data.gov.sg";
export const ACRA_INITIATE = `https://${ACRA_API_HOST}/v1/public/api/datasets/${ACRA_DATASET_ID}/initiate-download`;
export const ACRA_POLL = `https://${ACRA_API_HOST}/v1/public/api/datasets/${ACRA_DATASET_ID}/poll-download`;
/** Download hosts returned by poll-download. UNVERIFIED: empty by default, so downloads fail closed
 *  until an operator verifies the real host and passes it explicitly (exact hostname, no wildcards). */
export const ACRA_VERIFIED_DOWNLOAD_HOSTS: string[] = [];
/** Stricter of the two published limits: at most 5 API requests per minute -> 12 s spacing. */
export const ACRA_MIN_GAP_MS = 12_000;

export const REQUIRED = ["uen", "entity_name"] as const;
export const OPTIONAL = ["uen_status_desc", "entity_type_desc", "uen_issue_date", "issuance_agency_desc", "reg_street_name", "reg_postal_code"] as const;

export interface PollObservation { attempt: number; status: string | null; hasUrl: boolean; errorMsg: string | null; code: unknown }

/** initiate -> poll until a URL appears, an error is reported, or the budget is exhausted. */
export async function acraRequestDownloadUrl(deps: FetchDeps, opts: { maxPolls?: number; budgetMs?: number; downloadHosts?: string[]; pacer?: Pacer } = {}) {
  const pacer = opts.pacer ?? new Pacer(ACRA_MIN_GAP_MS, deps);
  const api = { allowedHosts: [ACRA_API_HOST], timeoutMs: 30_000, maxRetries: 3, pacer, accept: "application/json" };
  const observations: PollObservation[] = [];
  const init = (await readSmallJson(await safeGet(ACRA_INITIATE, api, deps))) as Record<string, unknown>;
  const initErr = errMsg(init);
  if (initErr) throw new FetchRejected(`initiate-download reported an error: ${initErr.slice(0, 200)}`);
  const maxPolls = opts.maxPolls ?? 20;
  const deadline = deps.now() + (opts.budgetMs ?? 6 * 60_000);
  for (let attempt = 1; attempt <= maxPolls && deps.now() < deadline; attempt++) {
    const body = (await readSmallJson(await safeGet(ACRA_POLL, api, deps))) as Record<string, unknown>;
    const data = (body && typeof body.data === "object" && body.data) ? body.data as Record<string, unknown> : {};
    const obs: PollObservation = { attempt, status: typeof data.status === "string" ? data.status.slice(0, 40) : null,
      hasUrl: typeof data.url === "string" && data.url.length > 0, errorMsg: errMsg(body), code: body?.code };
    observations.push(obs);
    if (obs.errorMsg) throw Object.assign(new FetchRejected(`poll-download reported an error: ${obs.errorMsg.slice(0, 200)}`), { observations });
    if (obs.hasUrl) {
      const url = String(data.url);
      let host = "";
      try { host = new URL(url).hostname; } catch { throw Object.assign(new FetchRejected("poll-download returned an invalid URL"), { observations }); }
      const hosts = opts.downloadHosts ?? ACRA_VERIFIED_DOWNLOAD_HOSTS;
      if (!hosts.includes(host.toLowerCase())) {
        throw Object.assign(new FetchRejected(`ACRA download host "${host}" is not verified; refusing. Verify it, then pass --trust-download-host ${host}.`), { observations });
      }
      return { url, host, observations };
    }
  }
  throw Object.assign(new FetchRejected(`poll budget exhausted after ${observations.length} polls without a download URL`), { observations });
}

function errMsg(body: unknown): string | null {
  if (!body || typeof body !== "object") return "response is not a JSON object";
  const e = (body as Record<string, unknown>).errorMsg;
  return typeof e === "string" && e.trim() ? e : null;
}

export interface AcraStats {
  columns: string[]; missing_optional: string[]; extra_columns: string[];
  csv_errors: number; missing_name: number; missing_uen: number; nonstandard_uen: number; invalid_dates: number; status_values: Record<string, number>;
}

/** Strict streaming CSV -> records. Throws (whole import fails) on changed required columns,
 *  invalid UTF-8 or an unterminated/truncated file; malformed rows become RowErrors. */
export async function* acraRecords(chunks: AsyncIterable<Uint8Array>, stats: AcraStats, opts: { accessedOn?: string } = {}): AsyncGenerator<SourceRecord | RowError> {
  let skipped = 0, lastSkipLine = -1, quoteNotClosed = false;
  const parser = parse({
    bom: true,
    columns: (header: string[]) => {
      const cols = header.map(h => String(h).trim().toLowerCase());
      for (const r of REQUIRED) if (!cols.includes(r)) throw new Error(`changed schema: required column "${r}" missing`);
      if (new Set(cols).size !== cols.length) throw new Error("changed schema: duplicate column names");
      stats.columns = cols;
      stats.missing_optional = OPTIONAL.filter(c => !cols.includes(c));
      stats.extra_columns = cols.filter(c => !(REQUIRED as readonly string[]).includes(c) && !(OPTIONAL as readonly string[]).includes(c)).slice(0, 20);
      return cols;
    },
    skip_records_with_error: true,
    max_record_size: 64 * 1024,
    trim: false,
    on_skip: (err: { code?: string } | undefined) => {
      if (err?.code === "CSV_QUOTE_NOT_CLOSED") quoteNotClosed = true; // EOF inside a quoted field: truncated
      skipped++; lastSkipLine = parser.info.lines;
    },
  } as unknown as Options);
  let lastByte = -1;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pump = (async () => {
    try {
      for await (const c of chunks) {
        if (c.length) lastByte = c[c.length - 1];
        const s = decoder.decode(c, { stream: true });
        if (!parser.write(s)) await new Promise(r => parser.once("drain", r));
      }
      parser.end(decoder.decode());
    } catch (e) {
      parser.destroy(new Error((e as Error).name === "TypeError" ? "invalid UTF-8 in CSV" : (e as Error).message));
    }
  })();
  let emittedSkips = 0;
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      while (emittedSkips < skipped) { emittedSkips++; stats.csv_errors++; yield new RowError("malformed CSV row"); }
      yield mapRow(row, stats, opts.accessedOn);
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/Quote Not Closed|quote/i.test(msg)) throw new Error("malformed or truncated CSV (unterminated quoted field)");
    throw new Error(msg.startsWith("changed schema") || msg.startsWith("invalid UTF-8") ? msg : `CSV parse failed: ${msg.slice(0, 160)}`);
  }
  await pump;
  if (quoteNotClosed) throw new Error("malformed or truncated CSV (unterminated quoted field)");
  while (emittedSkips < skipped) { emittedSkips++; stats.csv_errors++; yield new RowError("malformed CSV row"); }
  if (lastByte !== 0x0a && lastByte !== 0x0d && skipped > 0 && lastSkipLine >= parser.info.lines - 1) {
    throw new Error("possibly truncated CSV: last line is incomplete");
  }
}

function mapRow(row: Record<string, string>, stats: AcraStats, _accessedOn?: string): SourceRecord | RowError {
  const v = (k: string) => { const x = row[k]; return typeof x === "string" && x.trim() ? x.trim() : null; };
  const uenRaw = v("uen");
  const name = v("entity_name");
  if (!uenRaw) { stats.missing_uen++; return new RowError("missing uen"); }
  if (!name) { stats.missing_name++; return new RowError("missing entity_name"); } // never invent a name
  const std = normalizeUen(uenRaw);
  const uen = std ?? uenRaw.toUpperCase();
  if (!std) {
    if (!/^[A-Z0-9]{5,15}$/.test(uen)) return new RowError("invalid uen");
    stats.nonstandard_uen++;
  }
  const status = v("uen_status_desc");
  if (status) stats.status_values[status] = (stats.status_values[status] ?? 0) + 1;
  const dates: SourceRecord["dates"] = [];
  const issue = v("uen_issue_date");
  if (issue) {
    if (datePrecision(issue)) dates.push({ type: "uen_issue", value: issue, source_field: "uen_issue_date" });
    else stats.invalid_dates++;
  }
  const props: Record<string, string> = {};
  const map: [string, string][] = [["uen_status_desc", "registry_status"], ["entity_type_desc", "entity_type"], ["issuance_agency_desc", "issuance_agency"], ["reg_street_name", "street"], ["reg_postal_code", "postal_code"]];
  for (const [col, key] of map) { const x = v(col); if (x) props[key] = x.slice(0, 300); } // postal code stays text: leading zeroes kept
  return {
    id: `acra:${uen}`, kind: "company", schema: "RegisteredEntity", caption: name.slice(0, 1000),
    names: [{ value: name.slice(0, 1000), type: "primary" }],
    countries: ["sg"], topics: [], // a registry record is never tagged sanctioned/PEP/suspicious
    // Per-source constants (dataset title, dataset link, provenance note, identifier label) are NOT
    // repeated on 2.1M rows: they live in the source definition and are filled in at display time.
    datasets: [{ id: "acra_entities" }],
    identifiers: [{ type: "uen", value: uen }],
    dates, links: [],
    properties: props,
    provenance: {},
    referents: [],
  };
}

export function newAcraStats(): AcraStats {
  return { columns: [], missing_optional: [], extra_columns: [], csv_errors: 0, missing_name: 0, missing_uen: 0, nonstandard_uen: 0, invalid_dates: 0, status_values: {} };
}
