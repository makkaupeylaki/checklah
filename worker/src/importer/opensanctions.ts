// OpenSanctions default collection (entities.ftm.json, one FtM entity per line).
// Verified contract (docs packet): NDJSON; properties are multi-valued string arrays; topics in
// properties.topics; datasets; referents; root first_seen/last_change are processing metadata.
// Reference property names used for context (Sanction.entity, Family.person, ...) come from the FtM
// model and are NOT in the verified packet: they are listed in docs/source-contracts.md as an
// unresolved contract item and every missing field degrades to "Not supplied".
//
// Scope: Singapore-linked subset. An entity is selected only if one of ITS OWN country-type
// properties contains "sg". Relationship/sanction entities are context, never results.

import { RowError, type SourceRecord } from "./records.ts";
import { datePrecision, normalizeUen } from "../normalize.ts";

export const OS_URL = "https://data.opensanctions.org/datasets/latest/default/entities.ftm.json";
export const OS_HOSTS = ["data.opensanctions.org"];
export const SG_FIELDS = ["country", "nationality", "citizenship", "jurisdiction", "mainCountry", "birthCountry"] as const;
export const SUBJECT_SCHEMAS: Record<string, "person" | "company"> = {
  Person: "person", Company: "company", Organization: "company", LegalEntity: "company", PublicBody: "company",
};
/** Context schema -> [property pointing at the subject(s), property pointing at the other party]. */
export const CONTEXT_REFS: Record<string, [string[], string[]]> = {
  Sanction: [["entity"], []],
  Identification: [["holder"], []],
  Passport: [["holder"], []],
  Family: [["person", "relative"], ["relative", "person"]],
  Associate: [["person", "associate"], ["associate", "person"]],
  Ownership: [["owner", "asset"], ["asset", "owner"]],
  Directorship: [["director", "organization"], ["organization", "director"]],
  Membership: [["member", "organization"], ["organization", "member"]],
  Employment: [["employee", "employer"], ["employer", "employee"]],
  UnknownLink: [["subject", "object"], ["object", "subject"]],
  Representation: [["agent", "client"], ["client", "agent"]],
  Occupancy: [["holder"], ["post"]],
};
export const MAX_LINE = 8 * 1024 * 1024;
const MAX_CONTEXT = 30;

export interface FtmEntity {
  id: string; schema: string; caption?: string; datasets?: string[]; referents?: string[];
  first_seen?: string; last_seen?: string; last_change?: string; properties?: Record<string, unknown[]>;
}

export interface OsStats {
  lines: number; malformed: number; by_schema: Record<string, number>; selected: number; excluded_not_sg: number;
  unsupported: number; unsupported_schemas: Record<string, number>; context_kept: number; context_truncated: number;
  sg_link_fields: Record<string, number>;
}
export function newOsStats(): OsStats {
  return { lines: 0, malformed: 0, by_schema: {}, selected: 0, excluded_not_sg: 0, unsupported: 0, unsupported_schemas: {}, context_kept: 0, context_truncated: 0, sg_link_fields: {} };
}

/** Split a byte stream into lines without holding more than one line (bounded by MAX_LINE). */
export async function* lines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder("utf-8", { fatal: true });
  let buf = "";
  for await (const c of chunks) {
    buf += dec.decode(c, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) yield line;
    }
    if (buf.length > MAX_LINE) throw new Error("line exceeds maximum length (malformed or not NDJSON)");
  }
  buf += dec.decode();
  if (buf.trim()) yield buf; // last line without newline: still parsed; a truncated JSON line fails JSON.parse
}

export function parseEntity(line: string): FtmEntity | null {
  let e: unknown;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id.length > 200 || typeof o.schema !== "string") return null;
  if (o.properties !== undefined && (typeof o.properties !== "object" || o.properties === null || Array.isArray(o.properties))) return null;
  return o as unknown as FtmEntity;
}

/** String values of a multi-valued property; tolerates missing/null/odd values. */
export function prop(e: FtmEntity, name: string): string[] {
  const v = e.properties?.[name];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, 200);
}

export function sgLinkFields(e: FtmEntity): string[] {
  return SG_FIELDS.filter(f => prop(e, f).some(v => v.toLowerCase() === "sg"));
}

// ---------------------------------------------------------------- passes

export type Opener = () => AsyncIterable<Uint8Array>;

export interface SelectionResult {
  selected: Map<string, { caption: string; schema: string }>;
  subjectLines: string[] | null; // used only when no spill function is provided (tests)
}

/** Pass 1: select Singapore-linked subjects. `spill` stores selected raw lines (e.g. a temp file). */
export async function passSelect(open: Opener, stats: OsStats, spill: (line: string) => Promise<void> | void): Promise<Map<string, { caption: string; schema: string }>> {
  const selected = new Map<string, { caption: string; schema: string }>();
  for await (const line of lines(open())) {
    stats.lines++;
    const e = parseEntity(line);
    if (!e) { stats.malformed++; continue; }
    stats.by_schema[e.schema] = (stats.by_schema[e.schema] ?? 0) + 1;
    if (SUBJECT_SCHEMAS[e.schema]) {
      const fields = sgLinkFields(e);
      if (!fields.length) { stats.excluded_not_sg++; continue; }
      for (const f of fields) stats.sg_link_fields[f] = (stats.sg_link_fields[f] ?? 0) + 1;
      if (selected.has(e.id)) continue;
      selected.set(e.id, { caption: String(e.caption ?? prop(e, "name")[0] ?? e.id).slice(0, 300), schema: e.schema });
      stats.selected++;
      await spill(line);
    } else if (!CONTEXT_REFS[e.schema]) {
      stats.unsupported++;
      stats.unsupported_schemas[e.schema] = (stats.unsupported_schemas[e.schema] ?? 0) + 1;
    }
  }
  return selected;
}

export interface ContextItem { kind: "sanction" | "identification" | "relation"; data: Record<string, unknown>; otherId?: string }

/** Pass 2: context entities that reference a selected subject. Bounded per subject. */
export async function passContext(open: Opener, selected: Map<string, unknown>, stats: OsStats) {
  const ctx = new Map<string, ContextItem[]>();
  const needed = new Set<string>();
  for await (const line of lines(open())) {
    const e = parseEntity(line);
    if (!e) continue;
    const refs = CONTEXT_REFS[e.schema];
    if (!refs) continue;
    const [subjectProps, otherProps] = refs;
    subjectProps.forEach((sp, i) => {
      for (const sid of prop(e, sp)) {
        if (!selected.has(sid)) continue;
        const list = ctx.get(sid) ?? [];
        if (list.length >= MAX_CONTEXT) { stats.context_truncated++; continue; }
        const item = contextItem(e, otherProps[i]);
        if (item.otherId) needed.add(item.otherId);
        list.push(item);
        ctx.set(sid, list);
        stats.context_kept++;
      }
    });
  }
  return { ctx, needed };
}

function contextItem(e: FtmEntity, otherProp: string | undefined): ContextItem {
  const first = (p: string) => prop(e, p)[0] ?? null;
  if (e.schema === "Sanction") {
    return { kind: "sanction", data: {
      authority: first("authority"), program: first("program"), country: first("country"), status: first("status"),
      listing_date: first("listingDate"), start_date: first("startDate"), end_date: first("endDate"),
      reason: first("reason"), source_url: first("sourceUrl"), datasets: (e.datasets ?? []).slice(0, 5),
    } };
  }
  if (e.schema === "Identification" || e.schema === "Passport") {
    // Identity document numbers are deliberately NOT kept.
    return { kind: "identification", data: { schema: e.schema, type: first("type"), country: first("country") } };
  }
  const otherId = otherProp ? prop(e, otherProp)[0] : undefined;
  const role = first("relationship") ?? first("role") ?? null;
  return { kind: "relation", otherId, data: { schema: e.schema, role } };
}

/** Pass 3: captions/schemas for referenced entities (positions, related parties). Bounded set. */
export async function passResolve(open: Opener, needed: Set<string>, maxIds = 200_000) {
  const out = new Map<string, { caption: string; schema: string; sg: boolean }>();
  if (!needed.size) return out;
  if (needed.size > maxIds) throw new Error("too many referenced entities to resolve");
  for await (const line of lines(open())) {
    // cheap pre-filter before JSON.parse
    const m = /"id"\s*:\s*"([^"]{1,200})"/.exec(line.slice(0, 400));
    if (m && !needed.has(m[1])) continue;
    const e = parseEntity(line);
    if (!e || !needed.has(e.id)) continue;
    out.set(e.id, { caption: String(e.caption ?? prop(e, "name")[0] ?? "").slice(0, 300), schema: e.schema, sg: sgLinkFields(e).length > 0 });
  }
  return out;
}

/** Build a CheckLah record for one selected subject line. */
export function toRecord(line: string, ctx: ContextItem[], resolved: Map<string, { caption: string; schema: string; sg: boolean }>, selected: Map<string, { caption: string; schema: string }>): SourceRecord | RowError {
  const e = parseEntity(line);
  if (!e) return new RowError("malformed entity");
  const kind = SUBJECT_SCHEMAS[e.schema];
  if (!kind) return new RowError("unsupported schema");
  const names: SourceRecord["names"] = [];
  const caption = String(e.caption ?? prop(e, "name")[0] ?? "").trim();
  if (!caption) return new RowError("entity without a name");
  names.push({ value: caption, type: "primary" });
  for (const n of prop(e, "name")) if (n !== caption) names.push({ value: n, type: "alias" });
  for (const n of prop(e, "alias")) names.push({ value: n, type: "alias" });
  for (const n of prop(e, "weakAlias")) names.push({ value: n, type: "weak_alias" });
  for (const n of prop(e, "previousName")) names.push({ value: n, type: "previous" });
  const countries = [...new Set(SG_FIELDS.flatMap(f => prop(e, f)).map(c => c.toLowerCase()))].slice(0, 20);
  const sgFields = sgLinkFields(e);
  const identifiers: SourceRecord["identifiers"] = [];
  if (kind === "company") {
    const sgJur = prop(e, "jurisdiction").some(c => c.toLowerCase() === "sg") || prop(e, "country").some(c => c.toLowerCase() === "sg");
    for (const r of prop(e, "registrationNumber").slice(0, 5)) {
      identifiers.push({ type: "registration", value: r, label: "Registration number (as supplied)", sensitive: false });
      const uen = sgJur ? normalizeUen(r) : null;
      if (uen) identifiers.push({ type: "uen", value: uen, label: "UEN (from registration number)", sensitive: false });
    }
  } else {
    // Personal identity numbers are never stored: only the fact that the source supplies one.
    if (prop(e, "idNumber").length) identifiers.push({ type: "national_id", value: "", label: "National ID number", sensitive: true });
    if (prop(e, "passportNumber").length) identifiers.push({ type: "passport", value: "", label: "Passport number", sensitive: true });
  }
  const dates: SourceRecord["dates"] = [];
  const addDates = (p: string, type: string) => { for (const d of prop(e, p).slice(0, 5)) if (datePrecision(d)) dates.push({ type, value: d, source_field: p }); };
  if (kind === "person") { addDates("birthDate", "birth"); addDates("deathDate", "death"); }
  else { addDates("incorporationDate", "incorporation"); addDates("dissolutionDate", "dissolution"); }
  const sanctions = ctx.filter(c => c.kind === "sanction").map(c => c.data);
  for (const s of sanctions.slice(0, 5)) {
    // Actual sanction properties, not root processing metadata, provide listing dates.
    if (typeof s.listing_date === "string" && datePrecision(s.listing_date)) dates.push({ type: "sanction_listing", value: s.listing_date, source_field: "Sanction.listingDate" });
    else if (typeof s.start_date === "string" && datePrecision(s.start_date)) dates.push({ type: "sanction_start", value: s.start_date, source_field: "Sanction.startDate" });
  }
  const props: Record<string, string> = { sg_link: sgFields.join(", ") };
  const pos = prop(e, "position").slice(0, 3);
  if (pos.length) props.position = pos.join("; ").slice(0, 600);
  const notes = prop(e, "notes")[0];
  if (notes) props.notes = notes.slice(0, 800);
  const lf = prop(e, "legalForm")[0];
  if (lf) props.legal_form = lf.slice(0, 120);
  const relations = ctx.filter(c => c.kind === "relation").map(c => {
    const other = c.otherId ? resolved.get(c.otherId) : undefined;
    const inScope = !!(c.otherId && selected.has(c.otherId));
    const isPerson = other?.schema === "Person";
    return {
      schema: c.data.schema, role: c.data.role,
      // Names of related people outside the selected scope are not shown.
      other_caption: other && (inScope || !isPerson || c.data.schema === "Occupancy") ? other.caption : null,
      other_id: inScope ? `opensanctions:${c.otherId}` : null, in_scope: inScope,
    };
  });
  return {
    id: `opensanctions:${e.id}`, kind, schema: e.schema, caption: caption.slice(0, 1000),
    names: names.slice(0, 60), countries, topics: prop(e, "topics").slice(0, 20),
    datasets: (e.datasets ?? []).filter(d => typeof d === "string").slice(0, 20).map(d => ({ id: d })),
    identifiers, dates, links: prop(e, "sourceUrl").slice(0, 5).map(u => ({ label: "Source page (from OpenSanctions)", url: u })),
    properties: props,
    provenance: { first_seen: e.first_seen ?? null, last_change: e.last_change ?? null,
      note: "first_seen/last_change are OpenSanctions processing times, not listing dates." },
    context: { sanctions, relations, identifications: ctx.filter(c => c.kind === "identification").map(c => c.data),
      incomplete: true, note: "Context limited to entities that reference this record directly; other relationships may exist upstream." },
    referents: (e.referents ?? []).filter(r => typeof r === "string").slice(0, 50).map(r => `opensanctions:${r}`),
  };
}
