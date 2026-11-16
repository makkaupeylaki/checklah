// Candidate retrieval over D1. Lexical only: not identity matching. Every query is bound to the
// active generation of its source, resolved once per request (see `Snapshot`).

import type { Db } from "./db.ts";
import { classifyIdentifier, cleanInput, datePrecision, defang, fold, ftsQuery, MAX_QUERY_LEN, safeLink, similarName, tokens, urlHost, type Identifier } from "./normalize.ts";
import { SOURCE_BY_ID, SOURCES, type Mode, type SourceDef } from "./sources.ts";

export const PER_SOURCE_CAP = 200;
export const PAGE_SIZE = 20;
const FTS_SCAN_CAP = 2000;
const SIMILAR_CANDIDATES = 300;
const SIMILAR_TRIGGER = 5;

export const CATEGORIES: Record<string, string> = { person: "People", company: "Companies", website: "Websites", record: "Public records" };

const TOPIC_LABELS: Record<string, string> = {
  sanction: "Sanctions", "sanction.linked": "Sanctions-linked", "sanction.counter": "Counter-sanctions", "role.pep": "PEP",
  "role.rca": "PEP associate", debarment: "Debarment", "export.control": "Export control", crime: "Crime", wanted: "Wanted",
  poi: "Person of interest", "reg.warn": "Regulatory warning", "reg.action": "Regulatory action",
};
const DATE_LABELS: Record<string, string> = {
  birth: "Date of birth", listed: "Listed", registered: "Registered", status_changed: "Status changed",
  last_checked: "Last checked by source", uen_issue: "UEN issue date", incorporation: "Incorporation date",
  dissolution: "Dissolution date", sanction_listing: "Sanction listing date", sanction_start: "Sanction start date",
  sanction_end: "Sanction end date", death: "Date of death",
};
const PROPERTY_LABELS: Record<string, string> = {
  programme: "Programme", position: "Position", notes: "Source notes", registry_status: "Registry status",
  entity_type: "Entity type", listing_scope: "Listing scope", listing_status: "Listing status", threat_label: "Source label",
  issuance_agency: "Issuing agency", street: "Registered street", postal_code: "Registered postal code",
  sg_link: "Singapore link (field)", legal_form: "Legal form", gender: "Gender",
};
export const REASONS = {
  uen: "Exact UEN", url: "Exact URL listing", host: "Host listed by source",
  url_host: "URL on this host (listing covers that URL only)", registration: "Exact registration number",
  exact: "Name/alias exact match", text: "Name/alias text match", prefix: "Name/alias prefix match",
  similar: "Possible similar name",
} as const;
type Tier = keyof typeof REASONS;
const TIER_ORDER: Record<Tier, number> = { uen: 0, url: 0, host: 0, registration: 0, url_host: 1, exact: 1, text: 2, prefix: 3, similar: 4 };

export function topicLabel(t: string) { return TOPIC_LABELS[t] ?? (t.replace(/[._]/g, " ").replace(/^./, c => c.toUpperCase())); }
export function topicClass(t: string) {
  if (t === "sanction" || t.startsWith("sanction")) return "sanction";
  if (t.startsWith("role.pep") || t === "role.rca") return "pep";
  return "other";
}

export interface Query { text: string; mode: "name" | "identifier"; category: string; country: string; topic: string; cursor?: string | null }

interface SourceRow { id: string; active_gen: number | null; previous_gen: number | null; checked_at: string | null; last_attempt_at: string | null; last_success_at: string | null; last_error: string | null; last_error_at: string | null; g_rows: number | null; g_upstream_version: string | null; g_upstream_export_at: string | null; g_imported_at: string | null; g_last_changed_at: string | null; g_counts: string | null; g_scope: string | null }

/** The source/generation view of the database, read ONCE per request. */
export class Snapshot {
  readonly mode: Mode;
  readonly rows: Map<string, SourceRow>;
  readonly now: number;
  constructor(mode: Mode, rows: Map<string, SourceRow>, now: number) { this.mode = mode; this.rows = rows; this.now = now; }

  static async load(db: Db, mode: Mode, now = Date.now()): Promise<Snapshot> {
    const r = await db.prepare(
      "SELECT s.*, g.rows AS g_rows, g.upstream_version AS g_upstream_version, g.upstream_export_at AS g_upstream_export_at, " +
      "g.imported_at AS g_imported_at, g.last_changed_at AS g_last_changed_at, g.counts AS g_counts, g.scope AS g_scope " +
      "FROM sources s LEFT JOIN generations g ON g.id = s.active_gen AND g.state = 'active'").all<SourceRow>();
    const map = new Map<string, SourceRow>();
    for (const row of r.results) {
      const def = SOURCE_BY_ID.get(row.id);
      if (def && def.mode === mode) map.set(row.id, row); // other-mode rows are ignored entirely
    }
    return new Snapshot(mode, map, now);
  }

  gen(source: string): number | null {
    const def = SOURCE_BY_ID.get(source);
    if (!def || def.mode !== this.mode || !def.adapter) return null;
    const row = this.rows.get(source);
    return row?.active_gen != null && row.g_rows != null ? row.active_gen : null;
  }

  status(def: SourceDef) {
    const info: Record<string, unknown> = {
      id: def.id, title: def.title, kinds: def.kinds, scope: def.scope, licence: { name: def.licence.name, url: safeLink(def.licence.url) },
      homepage: safeLink(def.homepage), refresh: def.refresh, demo: def.mode === "demo", notes: def.notes,
    };
    if (def.mode !== this.mode) return { ...info, attribution: def.attribution.replace("{accessed}", "(date of access)"), state: "not_loaded", reason: def.blockedReason ?? `Not loaded in ${this.mode} mode.` };
    if (!def.adapter) return { ...info, attribution: def.attribution, state: "not_connected", reason: def.blockedReason };
    const row = this.rows.get(def.id);
    const imported = row?.g_imported_at ?? null;
    Object.assign(info, {
      attribution: def.attribution.replace("{accessed}", imported ? imported.slice(0, 10) : "(not yet imported)"),
      checked_at: row?.checked_at ?? null, last_attempt: row?.last_attempt_at ?? null, last_success: row?.last_success_at ?? null,
      last_error: row?.last_error ?? null, last_error_at: row?.last_error_at ?? null,
      imported_at: imported, upstream_exported_at: row?.g_upstream_export_at ?? null, upstream_version: row?.g_upstream_version ?? null,
      last_changed_at: row?.g_last_changed_at ?? null, rows: row?.g_rows ?? null,
      counts: row?.g_counts ? JSON.parse(row.g_counts) : null, has_previous: row?.previous_gen != null,
    });
    if (this.gen(def.id) == null) return { ...info, state: "not_imported", reason: "Adapter available, but no validated snapshot has been imported. Not searched." };
    const reasons: string[] = [];
    const age = (iso: string | null | undefined) => (iso ? (this.now - Date.parse(iso)) / 3600_000 : null);
    const a = age(imported), u = age(row?.g_upstream_export_at), c = age(row?.checked_at);
    if (def.stale.importHours && a != null && a > def.stale.importHours) reasons.push(`local import is older than ${def.stale.importHours} hours`);
    if (def.stale.upstreamHours && u != null && u > def.stale.upstreamHours) reasons.push(`upstream export is older than ${fmtHours(def.stale.upstreamHours)}`);
    if (def.stale.checkHours && c != null && c > def.stale.checkHours) reasons.push(`upstream not checked for over ${fmtHours(def.stale.checkHours)}`);
    const out = { ...info, state: reasons.length ? "stale" : "connected", stale_reasons: reasons } as Record<string, unknown>;
    if (row?.last_error) out.state_note = "Last import attempt failed; the previous good snapshot is still in use.";
    return out;
  }
}

function fmtHours(h: number) { return h % 24 === 0 ? `${h / 24} days` : `${h} hours`; }

export async function sourcesView(db: Db, mode: Mode, snap?: Snapshot) {
  snap ??= await Snapshot.load(db, mode);
  const items = SOURCES.filter(s => s.mode === mode || (mode === "demo" && s.mode === "live")).map(s => snap!.status(s));
  const connected = items.filter(s => s.state === "connected" || s.state === "stale");
  const categories = Object.entries(CATEGORIES).map(([kind, label]) => {
    const srcs = connected.filter(s => (s.kinds as string[]).includes(kind)).map(s => s.id);
    if (srcs.length) return { id: kind, label, enabled: true, sources: srcs };
    let reason = items.find(s => (s.kinds as string[]).includes(kind) && s.reason)?.reason as string | undefined ?? "No connected source.";
    if (kind === "record") reason = "Not connected: suitable source and reuse terms required.";
    if (kind === "website" && mode === "live") reason = "Not connected: PhishTank and URLhaus terms not yet approved; no adapter.";
    return { id: kind, label, enabled: false, reason, sources: [] };
  });
  const countries = new Set<string>();
  for (const s of connected) {
    const gen = snap.gen(s.id as string);
    if (gen == null) continue;
    // Bounded: read the delimited country codes of at most 5,000 rows (demo/OpenSanctions subsets
    // are small; for ACRA every row is "sg").
    const r = await db.prepare("SELECT DISTINCT country_codes AS c FROM (SELECT country_codes FROM entities WHERE gen = ? LIMIT 5000)").bind(gen).all<{ c: string }>();
    for (const row of r.results) for (const c of row.c.split(",")) if (/^[a-z]{2}$/.test(c)) countries.add(c);
  }
  return { mode, scope_note: mode === "live" ? "Selected sources and scope only. Not every person, company or website in the world." : null,
    sources: items, categories, countries: [...countries].sort().slice(0, 300) };
}

// ---------------------------------------------------------------- search

interface Cand { id: string; caption: string; caption_fold: string; kind: string; schema: string; countries: string; topics: string; datasets: string; matched?: string; mnorm?: string }

export interface ResultItem {
  id: string; caption: string; caption_defanged?: string; kind: string; schema: string; countries: string[];
  topics: { id: string; label: string; class: string }[]; datasets: string[]; source: { id: string; title: string };
  reason: string; matched_name?: string; demo: boolean; sg_link?: string;
}

const COLS = "e.id, e.caption, e.caption_fold, e.kind, e.schema, e.countries, e.topics, e.datasets";

function encodeCursor(k: [number, string, string]) { return btoa(unescape(encodeURIComponent(JSON.stringify(k)))); }
function decodeCursor(c: string | null | undefined): [number, string, string] | null {
  if (!c || c.length > 600) return null;
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(c))));
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === "number" && typeof v[1] === "string" && typeof v[2] === "string") return v as [number, string, string];
  } catch { /* fall through */ }
  return null;
}

export interface SearchResponse {
  mode: Mode; results: ResultItem[]; total: number; next_cursor: string | null; page_size?: number; position?: number;
  searched: { id: string; title: string; state: unknown }[]; unavailable: { id: string; title: string; state: string; reason: string }[];
  errors: { id: string; title: string; message: string }[]; capped: boolean; notice?: string; identifier_type?: string;
}

export async function search(db: Db, mode: Mode, q: Query, snap?: Snapshot): Promise<SearchResponse> {
  snap ??= await Snapshot.load(db, mode);
  const text = cleanInput(q.text).slice(0, MAX_QUERY_LEN);
  const out: SearchResponse = { mode, results: [], total: 0, next_cursor: null, searched: [], unavailable: [], errors: [], capped: false };
  let ident: Identifier | null = null;
  if (q.mode === "identifier") {
    ident = classifyIdentifier(text);
    if (!ident) return { ...out, notice: "Not a supported identifier. Supported: Singapore UEN, URL (http/https) or domain.", total: 0, next_cursor: null };
    out.identifier_type = ident.type;
  } else if (!tokens(text).length) {
    return { ...out, notice: "Enter a name with at least one letter or number.", total: 0, next_cursor: null };
  }
  type Keyed = ResultItem & { _k: [number, string, string] };
  const all: Keyed[] = [];
  for (const def of SOURCES) {
    if (def.mode !== mode || !def.adapter) continue;
    if (q.category !== "all" && !def.kinds.includes(q.category as never)) continue;
    if (ident?.type === "uen" && !def.kinds.includes("company")) continue;
    if ((ident?.type === "url" || ident?.type === "domain") && !def.kinds.includes("website")) continue;
    const gen = snap.gen(def.id);
    if (gen == null) {
      out.unavailable.push({ id: def.id, title: def.title, state: "not_imported", reason: "No validated snapshot imported." });
      continue;
    }
    try {
      const { items, capped } = await searchSource(db, def, gen, q, text, ident);
      if (capped) out.capped = true;
      for (const it of items) all.push(it as Keyed);
      out.searched.push({ id: def.id, title: def.title, state: snap.status(def).state });
    } catch {
      out.errors.push({ id: def.id, title: def.title, message: "Source could not be searched right now." });
    }
  }
  all.sort((a, b) => cmpKey(a._k, b._k));
  const after = decodeCursor(q.cursor);
  const start = after ? all.findIndex(x => cmpKey(x._k, after) > 0) : 0;
  const pageItems = start < 0 ? [] : all.slice(start, start + PAGE_SIZE);
  const hasMore = start >= 0 && start + PAGE_SIZE < all.length;
  return {
    ...out, total: all.length, page_size: PAGE_SIZE,
    results: pageItems.map(({ _k, ...rest }) => rest),
    next_cursor: hasMore ? encodeCursor(pageItems[pageItems.length - 1]._k) : null,
    position: start < 0 ? all.length : start,
  };
}

function cmpKey(a: [number, string, string], b: [number, string, string]) {
  return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

function filterSql(q: Query): [string, unknown[]] {
  const sql: string[] = [], args: unknown[] = [];
  if (q.category !== "all") { sql.push("e.kind = ?"); args.push(q.category); }
  if (q.topic === "sanction" || q.topic === "pep") { sql.push("instr(e.topic_flags, ?) > 0"); args.push(`,${q.topic},`); }
  if (q.country) { sql.push("instr(e.country_codes, ?) > 0"); args.push(`,${q.country},`); }
  return [sql.length ? " AND " + sql.join(" AND ") : "", args];
}

async function searchSource(db: Db, def: SourceDef, gen: number, q: Query, text: string, ident: Identifier | null) {
  const [fsql, fargs] = filterSql(q);
  const found = new Map<string, ResultItem & { _k: [number, string, string] }>();
  let capped = false;
  const take = (rows: Cand[], tier: Tier) => {
    for (const r of rows) {
      if (found.has(r.id)) continue;
      if (found.size >= PER_SOURCE_CAP) { capped = true; break; }
      found.set(r.id, summary(r, def, tier));
    }
  };
  const run = (sql: string, args: unknown[]) => db.prepare(sql + fsql + ` LIMIT ${PER_SOURCE_CAP + 1}`).bind(...args, ...fargs).all<Cand>().then(r => r.results);
  const identJoin = `SELECT ${COLS} FROM identifiers i JOIN entities e ON e.gen = i.gen AND e.id = i.entity_id WHERE i.type = ? AND i.norm = ? AND i.gen = ?`;

  if (ident) {
    if (ident.type === "uen") {
      take(await run(identJoin, ["uen", ident.value, gen]), "uen");
      take(await run(identJoin, ["registration", ident.value, gen]), "registration");
    } else if (ident.type === "url") {
      take(await run(identJoin, ["url", ident.value, gen]), "url");
      const host = urlHost(ident.value);
      if (host) take(await run(identJoin + " AND i.scope = 'host'", ["domain", host, gen]), "host");
    } else {
      take(await run(identJoin, ["domain", ident.value, gen]), "host");
      take(await run(identJoin, ["url_host", ident.value, gen]), "url_host");
    }
    return { items: [...found.values()], capped };
  }

  const norm = fold(text);
  take(await run(`SELECT ${COLS}, n.name AS matched FROM names n JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE n.gen = ? AND n.norm = ?`, [gen, norm]), "exact");
  const match = ftsQuery(text, gen);
  const last = tokens(text).at(-1)!;
  if (match && found.size < PER_SOURCE_CAP) {
    const rows = await db.prepare(
      `SELECT ${COLS}, n.name AS matched, n.norm AS mnorm FROM names_fts f CROSS JOIN names n ON n.nid = f.rowid ` +
      `JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE names_fts MATCH ? AND n.gen = ?` + fsql + ` LIMIT ${FTS_SCAN_CAP}`)
      .bind(match, gen, ...fargs).all<Cand>();
    if (rows.results.length >= FTS_SCAN_CAP) capped = true;
    for (const r of rows.results) {
      if (found.has(r.id)) continue;
      if (found.size >= PER_SOURCE_CAP) { capped = true; break; }
      found.set(r.id, summary(r, def, r.mnorm!.split(" ").includes(last) ? "text" : "prefix"));
    }
  }
  // Possible similar name: only when the lexical tiers found little. Bounded candidate set from a
  // 3-character prefix of each token, reranked with a capped edit distance. Never a full-table scan.
  if (found.size < SIMILAR_TRIGGER) {
    const pre = ftsQuery(text, gen, { prefixAll: 3 });
    if (pre) {
      const rows = await db.prepare(
        `SELECT ${COLS}, n.name AS matched, n.norm AS mnorm FROM names_fts f CROSS JOIN names n ON n.nid = f.rowid ` +
        `JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE names_fts MATCH ? AND n.gen = ?` + fsql + ` LIMIT ${SIMILAR_CANDIDATES}`)
        .bind(pre, gen, ...fargs).all<Cand>();
      for (const r of rows.results) {
        if (found.has(r.id) || found.size >= PER_SOURCE_CAP) continue;
        if (similarName(norm, r.mnorm!)) found.set(r.id, summary(r, def, "similar"));
      }
    }
  }
  return { items: [...found.values()], capped };
}

function summary(r: Cand, def: SourceDef, tier: Tier): ResultItem & { _k: [number, string, string] } {
  const topics: string[] = JSON.parse(r.topics || "[]");
  const datasets: { id: string; title?: string }[] = JSON.parse(r.datasets || "[]");
  const item: ResultItem & { _k: [number, string, string] } = {
    id: r.id, caption: r.caption, kind: r.kind, schema: r.schema,
    countries: (JSON.parse(r.countries || "[]") as string[]).slice(0, 6),
    topics: topics.slice(0, 8).map(t => ({ id: t, label: topicLabel(t), class: topicClass(t) })),
    datasets: datasets.slice(0, 4).map(d => d.title || def.recordDefaults?.datasetTitles?.[d.id] || d.id),
    source: { id: def.id, title: def.title }, reason: REASONS[tier], demo: def.mode === "demo",
    _k: [TIER_ORDER[tier], r.caption_fold, r.id],
  };
  if (r.matched && fold(r.matched) !== fold(r.caption)) item.matched_name = r.matched;
  if (r.kind === "website") item.caption_defanged = defang(r.caption);
  return item;
}

// ---------------------------------------------------------------- detail

interface EntityRow { id: string; kind: string; schema: string; caption: string; countries: string; topics: string; datasets: string; identifiers: string; dates: string; links: string; properties: string; provenance: string; context: string | null }

export async function record(db: Db, mode: Mode, recordId: string, snap?: Snapshot) {
  if (typeof recordId !== "string" || recordId.length > 200 || !recordId.includes(":")) return null;
  const source = recordId.slice(0, recordId.indexOf(":"));
  const def = SOURCE_BY_ID.get(source);
  if (!def || def.mode !== mode) return null;
  snap ??= await Snapshot.load(db, mode);
  const gen = snap.gen(source); // resolved once; used for every query below
  if (gen == null) return null;
  let row = await db.prepare("SELECT * FROM entities WHERE gen = ? AND id = ?").bind(gen, recordId).first<EntityRow>();
  let resolvedFrom: string | null = null;
  if (!row) {
    const ref = await db.prepare("SELECT entity_id FROM referents WHERE gen = ? AND old_id = ?").bind(gen, recordId).first<{ entity_id: string }>();
    if (ref) {
      row = await db.prepare("SELECT * FROM entities WHERE gen = ? AND id = ?").bind(gen, ref.entity_id).first<EntityRow>();
      resolvedFrom = recordId;
    }
  }
  if (!row) return null;
  const names = await db.prepare("SELECT name, type FROM names WHERE gen = ? AND entity_id = ? ORDER BY nid LIMIT 100").bind(gen, row.id).all<{ name: string; type: string }>();
  const J = <T,>(s: string | null, d: T): T => (s ? JSON.parse(s) : d);
  const identifiers = J<{ type: string; value: string; label?: string; sensitive?: boolean; scope?: string }[]>(row.identifiers, []).map(i => {
    const base = { type: i.type, label: i.label || def.recordDefaults?.identifierLabels?.[i.type] || i.type.toUpperCase(), scope: i.scope ?? null };
    if ((i.sensitive ?? true) && !["uen", "url", "domain", "registration"].includes(i.type)) return { ...base, masked: true, value: null };
    if (i.type === "url" || i.type === "domain") return { ...base, masked: false, value: null, defanged: defang(String(i.value ?? "")) };
    return { ...base, masked: false, value: String(i.value ?? "").slice(0, 100) };
  });
  const dates = J<{ type: string; value: string; source_field?: string }[]>(row.dates, []).map(d => ({
    type: d.type, label: DATE_LABELS[d.type] ?? d.type.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()),
    value: String(d.value), precision: datePrecision(String(d.value)), source_field: d.source_field ?? null,
  }));
  const storedLinks = J<{ label?: string; url: string }[]>(row.links, []);
  if (!storedLinks.length && def.recordDefaults?.link) storedLinks.push(def.recordDefaults.link);
  const links = storedLinks.flatMap(l => {
    const url = safeLink(l.url);
    return url ? [{ label: String(l.label || "Source page").slice(0, 120), url }] : [];
  });
  const properties = Object.entries(J<Record<string, unknown>>(row.properties, {})).flatMap(([k, v]) =>
    typeof v === "string" || typeof v === "number" ? [{ key: k, label: PROPERTY_LABELS[k] ?? k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()), value: String(v).slice(0, 2000) }] : []);
  const prov = J<Record<string, string | null>>(row.provenance, {});
  const topics = J<string[]>(row.topics, []);
  const st = snap.status(def) as Record<string, unknown>;
  return {
    id: row.id, resolved_from: resolvedFrom, kind: row.kind, schema: row.schema, caption: row.caption,
    caption_defanged: row.kind === "website" ? defang(row.caption) : null,
    names: names.results.map(n => ({ value: n.name, type: n.type })),
    countries: J<string[]>(row.countries, []),
    topics: topics.map(t => ({ id: t, label: topicLabel(t), class: topicClass(t) })),
    datasets: J<{ id: string; title?: string }[]>(row.datasets, []).map(d => ({ id: d.id, title: d.title ?? def.recordDefaults?.datasetTitles?.[d.id] ?? d.id })),
    identifiers, dates, links, properties,
    provenance: { first_seen: prov.first_seen ?? null, last_change: prov.last_change ?? null, published: prov.published ?? null, note: prov.note ?? def.recordDefaults?.note ?? null },
    context: sanitizeContext(row.context),
    source: {
      id: def.id, title: def.title, state: st.state, stale_reasons: st.stale_reasons ?? [], attribution: st.attribution,
      licence: { name: def.licence.name, url: safeLink(def.licence.url) }, imported_at: st.imported_at ?? null,
      upstream_exported_at: st.upstream_exported_at ?? null, upstream_version: st.upstream_version ?? null,
    },
    demo: def.mode === "demo",
  };
}

/** Context (OpenSanctions sanctions / relationships) is source text: pass through only known string
 *  fields, with safe links, so nothing executable or unexpected reaches the client. */
function sanitizeContext(raw: string | null) {
  if (!raw) return null;
  const c = JSON.parse(raw) as { sanctions?: Record<string, unknown>[]; relations?: Record<string, unknown>[]; identifications?: Record<string, unknown>[]; incomplete?: boolean; note?: string };
  const str = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
  return {
    sanctions: (c.sanctions ?? []).slice(0, 30).map(s => ({
      authority: str(s.authority), program: str(s.program), country: str(s.country, 10), status: str(s.status),
      listing_date: str(s.listing_date, 20), start_date: str(s.start_date, 20), end_date: str(s.end_date, 20),
      reason: str(s.reason, 600), source_url: safeLink(s.source_url), datasets: Array.isArray(s.datasets) ? (s.datasets as unknown[]).filter(x => typeof x === "string").slice(0, 5) : [],
    })),
    relations: (c.relations ?? []).slice(0, 30).map(r => ({
      schema: str(r.schema, 40), role: str(r.role, 200), other_caption: str(r.other_caption, 300), other_id: str(r.other_id, 200), in_scope: r.in_scope === true,
    })),
    identifications: (c.identifications ?? []).slice(0, 20).map(i => ({ schema: str(i.schema, 40), type: str(i.type, 80), country: str(i.country, 10) })),
    incomplete: c.incomplete !== false,
    note: str(c.note, 500),
  };
}
