// Connector-neutral record shape and its D1 row mapping.

import { fold, normalizeHost, normalizeUen, normalizeUrl, cleanInput, urlHost } from "../normalize.ts";
import type { Kind } from "../sources.ts";

export const NAME_TYPES = ["primary", "alias", "weak_alias", "previous"] as const;
export type NameType = typeof NAME_TYPES[number];
const KINDS: Kind[] = ["person", "company", "website", "record", "other"];

export interface SourceRecord {
  id: string;
  kind: Kind;
  schema: string;
  caption: string;
  names: { value: string; type: NameType }[];
  countries: string[];
  topics: string[];
  datasets: { id: string; title?: string }[];
  identifiers: { type: string; value: string; label?: string; sensitive?: boolean; scope?: string }[];
  dates: { type: string; value: string; source_field?: string }[];
  links: { label: string; url: string }[];
  properties: Record<string, string>;
  provenance: Record<string, string | null | undefined>;
  context?: unknown;
  referents: string[];
}

export class RowError extends Error {}

const MAX_JSON = 60_000; // per-row JSON budget, far below D1's 2 MB row limit

export function validateRecord(r: SourceRecord, namespace: string): SourceRecord {
  if (typeof r.id !== "string" || !r.id.startsWith(namespace + ":") || r.id.length > 200) throw new RowError("id missing or outside namespace");
  if (!KINDS.includes(r.kind)) throw new RowError("unknown kind");
  if (typeof r.caption !== "string" || !r.caption.trim() || r.caption.length > 1000) throw new RowError("caption missing");
  for (const n of r.names) {
    if (typeof n.value !== "string" || !NAME_TYPES.includes(n.type)) throw new RowError("bad name entry");
  }
  for (const ref of r.referents) if (typeof ref !== "string" || !ref.startsWith(namespace + ":")) throw new RowError("referent outside namespace");
  if (!r.names.some(n => n.type === "primary")) r.names.unshift({ value: r.caption, type: "primary" });
  return r;
}

const j = (v: unknown) => JSON.stringify(v ?? null);

export function topicFlags(topics: string[]): string {
  const flags = new Set<string>();
  for (const t of topics) {
    if (t === "sanction" || t.startsWith("sanction.")) flags.add("sanction");
    else if (t === "role.pep" || t.startsWith("role.pep") || t === "role.rca") flags.add("pep");
  }
  return "," + [...flags].sort().join(",") + (flags.size ? "," : "");
}

export interface Rows {
  entities: unknown[][];
  names: unknown[][];
  fts: unknown[][];
  identifiers: unknown[][];
  referents: unknown[][];
}

export const ENTITY_COLS = ["gen", "id", "kind", "schema", "caption", "caption_fold", "country_codes", "topic_flags", "countries",
  "topics", "datasets", "identifiers", "dates", "links", "properties", "provenance", "context"];
export const NAME_COLS = ["nid", "gen", "entity_id", "name", "norm", "type"];
export const FTS_COLS = ["rowid", "norm", "g"];
export const IDENT_COLS = ["gen", "type", "norm", "entity_id", "scope"];
export const REF_COLS = ["gen", "old_id", "entity_id"];

/** Deterministic name row id: unique per generation and record position, so a retried chunk can
 *  never create duplicates (it collides on the primary key and the whole batch rolls back). */
export function nameId(gen: number, recordIndex: number, nameIndex: number): number {
  if (gen >= 2 ** 20 || recordIndex >= 2 ** 26 || nameIndex >= 64) throw new Error("name id space exceeded");
  return gen * 2 ** 32 + recordIndex * 64 + nameIndex;
}

export function toRows(gen: number, r: SourceRecord, recordIndex: number, out: Rows): void {
  const countries = [...new Set(r.countries.map(c => c.toLowerCase()).filter(c => /^[a-z]{2}$/.test(c)))];
  const entity = [gen, r.id, r.kind, r.schema, r.caption, fold(r.caption),
    "," + countries.join(",") + (countries.length ? "," : ""), topicFlags(r.topics),
    j(r.countries), j(r.topics), j(r.datasets), j(r.identifiers), j(r.dates), j(r.links), j(r.properties), j(r.provenance),
    r.context === undefined ? null : j(r.context)];
  const size = entity.reduce((n: number, v) => n + (typeof v === "string" ? v.length : 8), 0);
  if (size > MAX_JSON) throw new RowError("record too large");
  out.entities.push(entity);
  const seen = new Set<string>();
  let k = 0;
  for (const n of r.names) {
    const norm = fold(n.value);
    const key = norm + "\u0000" + n.type;
    if (!norm || seen.has(key) || k >= 63) continue;
    seen.add(key);
    const nid = nameId(gen, recordIndex, k++);
    out.names.push([nid, gen, r.id, n.value, norm, n.type]);
    out.fts.push([nid, norm, `g${gen}`]);
  }
  for (const ident of r.identifiers) {
    let norm: string | null = null;
    if (ident.type === "uen") norm = normalizeUen(ident.value);
    else if (ident.type === "url") norm = normalizeUrl(ident.value);
    else if (ident.type === "domain") norm = normalizeHost(ident.value);
    else if (ident.type === "registration") norm = cleanInput(ident.value).toUpperCase().slice(0, 100) || null;
    // Sensitive personal identifiers (passport, national ID) are never indexed or stored in rows.
    if (!norm) continue;
    out.identifiers.push([gen, ident.type, norm, r.id, ident.scope ?? null]);
    if (ident.type === "url") {
      const host = urlHost(norm);
      if (host) out.identifiers.push([gen, "url_host", host, r.id, "exact_url"]);
    }
  }
  for (const old of new Set(r.referents)) if (old !== r.id) out.referents.push([gen, old, r.id]);
}

export function emptyRows(): Rows {
  return { entities: [], names: [], fts: [], identifiers: [], referents: [] };
}
