// OpenSanctions adapter on a synthetic FtM contract fixture. No real export is read here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db.ts";
import { lines, newOsStats, passSelect, sgLinkFields, parseEntity } from "../src/importer/opensanctions.ts";
import { ImportRejected, runImport } from "../src/importer/lifecycle.ts";
import { acraRecords, newAcraStats } from "../src/importer/acra.ts";
import { record, search } from "../src/search.ts";
import { prepareOpenSanctions } from "../tools/cli.ts";
import { openTestDb, reset } from "./helpers.ts";
import { createReadStream } from "node:fs";

const FIX = join(import.meta.dirname, "fixtures");
const FILE = join(FIX, "os-contract.ndjson");
let db: Db, dispose: () => Promise<void>, tmp: string;
let prepStats: ReturnType<typeof newOsStats>;

before(async () => {
  ({ db, dispose } = await openTestDb("live"));
  await reset(db, "live");
  tmp = mkdtempSync(join(tmpdir(), "checklah-os-"));
  const prep = await prepareOpenSanctions(FILE, { version: "fixture-1", exported_at: "2026-11-16T00:00:00Z" }, "sha-fixture", tmp, { maxMalformedRatio: 0.1 });
  prepStats = prep.stats;
  await runImport(db, "opensanctions", prep);
  const acraStats = newAcraStats();
  await runImport(db, "acra", { upstream: { version: "f" }, scope: null, records: () => acraRecords(createReadStream(join(FIX, "acra-contract.csv")) as AsyncIterable<Uint8Array>, acraStats) }, { policy: { maxRejectRatio: 0.5 } });
});
after(async () => { await dispose(); rmSync(tmp, { recursive: true, force: true }); });

const Q = (text: string, o: Record<string, string> = {}) => ({ text, mode: "name" as const, category: "all", country: "", topic: "any", ...o });

test("selection predicate: only entities whose OWN country-type property is sg", () => {
  assert.equal(prepStats.selected, 8);
  assert.equal(prepStats.excluded_not_sg, 2, "foreign person and foreign subject of a Singapore-authority sanction are excluded");
  assert.deepEqual(prepStats.sg_link_fields, { nationality: 2, citizenship: 1, birthCountry: 1, jurisdiction: 1, mainCountry: 1, country: 2 });
  assert.equal(prepStats.malformed, 1);
  assert.equal(prepStats.unsupported_schemas.Vessel, 1, "unsupported schemas are counted, not imported");
  assert.equal(prepStats.unsupported_schemas.Position, 1);
  assert.ok(prepStats.context_kept >= 5);
});

test("no raw-text matching: 'Singapore' in notes or a Singapore authority does not select", async () => {
  assert.equal((await search(db, "live", Q("Fixture Listed By Singapore"))).results.filter(r => r.reason !== "Possible similar name").length, 0);
  assert.equal(await record(db, "live", "opensanctions:NK-fixture-sg-sanctioned-foreigner"), null);
  assert.equal(await record(db, "live", "opensanctions:NK-fixture-foreign"), null);
  assert.equal(await record(db, "live", "opensanctions:vessel-1"), null);
  assert.equal(await record(db, "live", "opensanctions:sanc-1"), null, "relationship/sanction entities are never results");
});

test("record: topics kept distinct, link field shown, partial dates, non-Latin aliases, referents", async () => {
  const p = (await record(db, "live", "opensanctions:NK-fixture-sg-person"))!;
  assert.deepEqual(p.topics.map(t => t.id), ["sanction"]);
  assert.ok(p.properties.some(x => x.label === "Singapore link (field)" && x.value === "nationality"));
  assert.deepEqual(p.dates.find(d => d.type === "birth"), { type: "birth", label: "Date of birth", value: "1982", precision: "year", source_field: "birthDate" });
  const listing = p.dates.find(d => d.type === "sanction_listing")!;
  assert.equal(listing.value, "2024-02");
  assert.equal(listing.precision, "month");
  assert.equal(listing.source_field, "Sanction.listingDate", "listing date from the Sanction entity, not first_seen");
  assert.ok(p.names.some(n => n.value === "Фикстура Персона") && p.names.some(n => n.value === "菲克斯"));
  assert.match(String(p.provenance.note), /processing times/);
  assert.equal((await record(db, "live", "opensanctions:fixture-old-1"))!.id, "opensanctions:NK-fixture-sg-person");
  const pep = (await record(db, "live", "opensanctions:NK-fixture-pep"))!;
  assert.deepEqual(pep.topics.map(t => t.class), ["pep"]);
  const crime = (await record(db, "live", "opensanctions:NK-fixture-birth"))!;
  assert.deepEqual(crime.topics.map(t => [t.id, t.class]), [["crime", "other"]], "not labelled sanctioned");
});

test("identity document numbers are never stored; unsafe source URLs dropped", async () => {
  const dump = await db.prepare("SELECT identifiers, context, properties FROM entities").all();
  assert.ok(!JSON.stringify(dump.results).includes("E0000000X"));
  const p = (await record(db, "live", "opensanctions:NK-fixture-sg-person"))!;
  const pp = p.identifiers.find(i => i.type === "passport")!;
  assert.ok(pp.masked && pp.value === null);
  assert.equal(p.context!.sanctions[0].source_url, null, "javascript: sourceUrl dropped");
  assert.equal(p.context!.sanctions[0].reason, "<b>reason</b> text", "kept as text; the UI escapes it");
  assert.equal(p.context!.identifications[0].country, "sg");
  assert.equal(p.links[0].url, "https://example.org/fixture/person");
});

test("context: relationships within scope named, related people outside scope not shown, incomplete flagged", async () => {
  const p = (await record(db, "live", "opensanctions:NK-fixture-sg-person"))!;
  const fam = p.context!.relations.find(r => r.schema === "Family")!;
  assert.equal(fam.other_caption, null, "relative outside the selected scope is not named");
  assert.equal(fam.role, "sibling");
  assert.equal(p.context!.incomplete, true);
  const pep = (await record(db, "live", "opensanctions:NK-fixture-pep"))!;
  const dir = pep.context!.relations.find(r => r.schema === "Directorship")!;
  assert.equal(dir.other_caption, "Fixture Holdings Pte Ltd");
  assert.equal(dir.in_scope, true);
  assert.equal(pep.context!.relations.find(r => r.schema === "Occupancy")!.other_caption, "Member, Fixture Council");
});

test("tolerates odd property shapes without crashing the export", async () => {
  const w = (await record(db, "live", "opensanctions:weird-1"))!;
  assert.equal(w.caption, "Fixture Odd Properties");
  assert.deepEqual(w.topics, []);
  assert.equal(w.dates.length, 0, "'unknown' is not a date");
  const u = (await search(db, "live", Q("jose nunez fixture"))).results[0];
  assert.equal(u.id, "opensanctions:NK-fixture-unicode");
});

test("cross-source: UEN matches both registry and watchlist but records are never merged", async () => {
  const r = await search(db, "live", Q("T99SY0001A", { mode: "identifier" }));
  assert.deepEqual(r.results.map(x => [x.id, x.reason]).sort(), [["acra:T99SY0001A", "Exact UEN"], ["opensanctions:NK-fixture-co", "Exact UEN"]]);
  const acra = (await record(db, "live", "acra:T99SY0001A"))!;
  assert.deepEqual(acra.topics, [], "registry record does not inherit watchlist topics");
});

test("sanctions/PEP topic filters on live data", async () => {
  const s = await search(db, "live", Q("fixture", { topic: "sanction" }));
  assert.ok(s.results.every(x => x.topics.some(t => t.class === "sanction")));
  const p = await search(db, "live", Q("fixture", { topic: "pep" }));
  assert.deepEqual(p.results.map(x => x.id), ["opensanctions:NK-fixture-pep"]);
});

test("too many malformed lines rejects the import before any write", async () => {
  await assert.rejects(prepareOpenSanctions(FILE, {}, "x", tmp), ImportRejected);
  const bad = join(tmp, "truncated.ndjson");
  writeFileSync(bad, readFileSync(FILE, "utf8").split("\n").slice(0, 3).join("\n") + '\n{"id":"NK-trunc","schema":"Person","propert');
  await assert.rejects(prepareOpenSanctions(bad, {}, "x", tmp), /malformed/);
});

test("line splitter: bounded line length; invalid UTF-8 fails", async () => {
  const big = (async function* () { yield new TextEncoder().encode("x".repeat(9 * 1024 * 1024)); })();
  await assert.rejects((async () => { for await (const _ of lines(big)) { /* drain */ } })(), /maximum length/);
  const badUtf = (async function* () { yield new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]); })();
  await assert.rejects((async () => { for await (const _ of lines(badUtf)) { /* drain */ } })());
  const e = parseEntity('{"id":"a","schema":"Person","properties":{"country":["SG"]}}')!;
  assert.deepEqual(sgLinkFields(e), ["country"]);
  const s = newOsStats();
  const sel = await passSelect(() => (async function* () { yield new TextEncoder().encode('{"id":"a","schema":"Person","caption":"A","properties":{"nationality":["sg"]}}\n{"id":"a","schema":"Person","caption":"A","properties":{"nationality":["sg"]}}\n'); })(), s, () => {});
  assert.equal(sel.size, 1, "duplicate IDs selected once");
});
