// ACRA adapter: CSV contract tests (synthetic fixtures) and the initiate/poll/download flow with a
// mocked network. No real data.gov.sg call is made here; live verification is pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../src/db.ts";
import { ACRA_MIN_GAP_MS, acraRecords, acraRequestDownloadUrl, newAcraStats } from "../src/importer/acra.ts";
import { FetchRejected, safeGet, streamBody, type FetchDeps } from "../src/importer/fetchpolicy.ts";
import { RowError, type SourceRecord } from "../src/importer/records.ts";
import { runImport } from "../src/importer/lifecycle.ts";
import { record, search } from "../src/search.ts";
import { openTestDb, reset } from "./helpers.ts";

const FIX = join(import.meta.dirname, "fixtures");
const bytes = (s: string | Uint8Array) => (async function* () { yield typeof s === "string" ? new TextEncoder().encode(s) : s; })();
async function collect(input: string | Uint8Array) {
  const stats = newAcraStats();
  const out: (SourceRecord | RowError)[] = [];
  for await (const r of acraRecords(bytes(input), stats)) out.push(r);
  return { out, stats, ok: out.filter((r): r is SourceRecord => !(r instanceof RowError)) };
}
const HEADER = "uen,issuance_agency_desc,uen_status_desc,entity_name,entity_type_desc,uen_issue_date,reg_street_name,reg_postal_code\n";

test("contract fixture: BOM, quoting, embedded comma/newline, leading-zero postal codes, partial dates, statuses", async () => {
  const { out, stats, ok } = await collect(readFileSync(join(FIX, "acra-contract.csv")));
  assert.equal(out.length, 6);
  assert.equal(ok.length, 5);
  assert.equal(stats.missing_name, 1, "nameless row rejected, never invented");
  assert.deepEqual(stats.missing_optional, []);
  const byId = Object.fromEntries(ok.map(r => [r.id, r]));
  const a = byId["acra:T99SY0001A"];
  assert.equal(a.caption, "SYNTHETIC FIXTURE ALPHA PTE. LTD.");
  assert.equal(a.properties.postal_code, "018956", "leading zero kept");
  assert.equal(a.properties.registry_status, "Registered");
  assert.deepEqual(a.topics, [], "registry records are never tagged");
  assert.deepEqual(a.dates, [{ type: "uen_issue", value: "2019-05-02", source_field: "uen_issue_date" }], "UEN issue date, not incorporation");
  const row = JSON.stringify(a);
  assert.ok(!row.includes("data.gov.sg") && !row.includes("not an assessment") && !row.includes("Entities Registered"), "per-source constants are not repeated on each row");
  const b = byId["acra:T99SY0002B"];
  assert.equal(b.caption, "SYNTHETIC FIXTURE, BETA & CO");
  assert.equal(b.properties.street, 'FIXTURE "QUOTED" ROAD');
  assert.equal(b.properties.registry_status, "Deregistered");
  assert.equal(b.dates[0].value, "2001-05", "partial date stays partial");
  assert.equal(byId["acra:T99SY0003C"].caption, "SYNTHETIC FIXTURE\nGAMMA (MULTI-LINE) LLP");
  assert.equal(byId["acra:T99SY0003C"].properties.postal_code, undefined, "absent optional stays absent");
  assert.equal(byId["acra:T99SY0004D"].dates.length, 0, "invalid date omitted, counted");
  assert.equal(stats.invalid_dates, 1);
  assert.ok(byId["acra:ODD123"], "non-standard UEN kept as supplied");
  assert.equal(stats.nonstandard_uen, 1);
  assert.deepEqual(stats.status_values, { Registered: 4, Deregistered: 1 }, "status vocabulary recorded for the contract (nameless row excluded)");
});

test("changed schema: missing required column fails the whole file", async () => {
  await assert.rejects(collect("uen,name\nT99SY0001A,X\n"), /required column "entity_name" missing/);
  await assert.rejects(collect("entity_name,uen_status_desc\nX,Registered\n"), /required column "uen" missing/);
  await assert.rejects(collect("uen,entity_name,uen\nA,B,C\n"), /duplicate column/);
});

test("extra and missing optional columns are tolerated and recorded", async () => {
  const { ok, stats } = await collect("UEN,Entity_Name,new_column\nT99SY0009Z,EXTRA COLUMN FIXTURE,x\n");
  assert.equal(ok.length, 1);
  assert.deepEqual(stats.extra_columns, ["new_column"]);
  assert.equal(stats.missing_optional.length, 6);
});

test("malformed rows become rejected rows; truncated or invalid files fail", async () => {
  const { out, stats } = await collect(HEADER + "T99SY0001A,ACRA,Registered,GOOD,Local Company,2020-01-01,S,1\nT99SY0002B,too,few\nT99SY0003C,ACRA,Registered,GOOD TWO,Local Company,2020,S,2,EXTRA\n");
  assert.equal(out.filter(r => r instanceof RowError).length, 2);
  assert.equal(stats.csv_errors, 2);
  await assert.rejects(collect(HEADER + 'T99SY0001A,ACRA,Registered,"UNTERMINATED,Local Company,2020,S,1\n'), /truncated|unterminated/i);
  await assert.rejects(collect(HEADER + "T99SY0001A,ACRA,Registered,GOOD,Local Company,2020,S,1\nT99SY0002B,ACRA,Reg"), /truncated/i);
  const bad = new Uint8Array([...new TextEncoder().encode(HEADER + "T99SY0001A,ACRA,Registered,"), 0xff, 0xfe, ...new TextEncoder().encode(",X,2020,S,1\n")]);
  await assert.rejects(collect(bad), /UTF-8/);
});

test("full import into live D1: UEN and name search, duplicates rejected, status shown, no topics", async () => {
  const { db, dispose } = await openTestDb("live");
  try {
    await reset(db, "live");
    const src = readFileSync(join(FIX, "acra-contract.csv"), "utf8") + "T99SY0001A,ACRA,Registered,DUPLICATE UEN ROW,Local Company,2019-05-02,X,1\n";
    const stats = newAcraStats();
    const r = await runImport(db as Db, "acra", { upstream: { version: "fixture", exportAt: null, checksum: "x" }, scope: null, records: () => acraRecords(bytes(src), stats) },
      { policy: { maxRejectRatio: 0.5 } });
    assert.equal(r.status, "imported");
    assert.equal((r.counts as { duplicates: number }).duplicates, 1);
    const q = { mode: "identifier" as const, category: "all", country: "", topic: "any" };
    const u = await search(db as Db, "live", { ...q, text: "t99sy0001a" });
    assert.deepEqual(u.results.map(x => [x.caption, x.reason]), [["SYNTHETIC FIXTURE ALPHA PTE. LTD.", "Exact UEN"]]);
    const n = await search(db as Db, "live", { ...q, mode: "name", text: "synthetic fixture beta" });
    assert.equal(n.results[0].id, "acra:T99SY0002B");
    assert.deepEqual(n.results[0].topics, []);
    const d = (await record(db as Db, "live", "acra:T99SY0002B"))!;
    assert.ok(d.properties.some(p => p.label === "Registry status" && p.value === "Deregistered"));
    assert.equal(d.dates[0].label, "UEN issue date");
    assert.match(String(d.source.attribution), /Singapore Open Data Licence version 1\.0/);
    assert.equal(d.datasets[0].title, "Entities Registered with ACRA", "dataset title from source defaults");
    assert.equal(d.links[0].url, "https://data.gov.sg/datasets/d_3f960c10fed6145404ca7b821f263b87/view");
    assert.match(String(d.provenance.note), /not an assessment/);
    assert.equal(d.identifiers[0].label, "UEN");
    assert.equal((await search(db as Db, "live", { ...q, mode: "name", text: "synthetic fixture beta", topic: "sanction" })).total, 0);
  } finally { await dispose(); }
});

// ---------------------------------------------------------------- network flow (mocked)

function mock(routes: (url: string, n: number) => Response | Promise<Response>) {
  let clock = 1_000_000;
  const calls: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const deps: FetchDeps = {
    fetch: (async (u: string | URL | Request) => { const url = String(u); calls.push({ url, at: clock }); return routes(url, calls.length); }) as typeof fetch,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  };
  return { deps, calls, sleeps };
}
const J = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("initiate -> pending polls -> URL on a verified host; requests spaced >= 12 s", async () => {
  const { deps, calls } = mock((url, n) => {
    if (url.endsWith("/initiate-download")) return J({ code: 0, data: { message: "started" } });
    if (n < 4) return J({ code: 0, data: { status: "SOME_PENDING_STATE" } });
    return J({ code: 0, data: { status: "SOME_DONE_STATE", url: "https://downloads.fixture.example/acra.csv?sig=1" } });
  });
  const r = await acraRequestDownloadUrl(deps, { downloadHosts: ["downloads.fixture.example"] });
  assert.equal(r.host, "downloads.fixture.example");
  assert.equal(r.observations.length, 3);
  assert.deepEqual(r.observations.map(o => o.status), ["SOME_PENDING_STATE", "SOME_PENDING_STATE", "SOME_DONE_STATE"], "status strings recorded, not interpreted");
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= ACRA_MIN_GAP_MS, "<= 5 requests/minute");
  assert.ok(calls.every(c => c.url.startsWith("https://api-open.data.gov.sg/v1/public/api/datasets/d_3f960c10fed6145404ca7b821f263b87/")));
});

test("unverified download host fails closed (default allowlist is empty)", async () => {
  const { deps } = mock(url => url.endsWith("/initiate-download") ? J({ data: {} }) : J({ data: { url: "https://unknown-bucket.example/x.csv" } }));
  await assert.rejects(acraRequestDownloadUrl(deps), /not verified; refusing/);
  const { deps: d2 } = mock(url => url.endsWith("/initiate-download") ? J({ data: {} }) : J({ data: { url: "http://downloads.fixture.example/x.csv" } }));
  const r = await acraRequestDownloadUrl(d2, { downloadHosts: ["downloads.fixture.example"] });
  await assert.rejects(safeGet(r.url, { allowedHosts: [r.host], timeoutMs: 1000 }, d2), /only https/, "http URL rejected at download time");
});

test("error responses, missing URL and exhausted poll budget", async () => {
  const e1 = mock(url => url.endsWith("/initiate-download") ? J({ errorMsg: "quota" }) : J({}));
  await assert.rejects(acraRequestDownloadUrl(e1.deps), /initiate-download reported an error/);
  const e2 = mock(url => url.endsWith("/initiate-download") ? J({ data: {} }) : J({ data: { status: "x" }, errorMsg: "failed" }));
  await assert.rejects(acraRequestDownloadUrl(e2.deps), /poll-download reported an error/);
  const e3 = mock(url => url.endsWith("/initiate-download") ? J({ data: {} }) : J({ data: { status: "x" } }));
  await assert.rejects(acraRequestDownloadUrl(e3.deps, { maxPolls: 4 }), /poll budget exhausted after 4 polls/);
  const e4 = mock(url => url.endsWith("/initiate-download") ? J({ data: {} }) : J({ data: { status: "x" } }));
  await assert.rejects(acraRequestDownloadUrl(e4.deps, { maxPolls: 1000, budgetMs: 60_000 }), /budget exhausted/);
  assert.ok(e4.calls.length < 10, "time budget bounds the number of polls");
  const e5 = mock(() => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(acraRequestDownloadUrl(e5.deps), /unexpected content type/);
});

test("429 with Retry-After is honoured; 403 is not retried; redirects are re-checked", async () => {
  const r1 = mock((url, n) => n === 1 ? J({}, 429, { "Retry-After": "30" }) : J({ data: {} }));
  await safeGet("https://api-open.data.gov.sg/x", { allowedHosts: ["api-open.data.gov.sg"], timeoutMs: 1000 }, r1.deps);
  assert.ok(r1.sleeps.includes(30_000));
  const r2 = mock(() => J({}, 429));
  await assert.rejects(safeGet("https://api-open.data.gov.sg/x", { allowedHosts: ["api-open.data.gov.sg"], timeoutMs: 1000, maxRetries: 2 }, r2.deps), /HTTP 429 after 3 attempts/);
  const r3 = mock(() => J({}, 403));
  await assert.rejects(safeGet("https://api-open.data.gov.sg/x", { allowedHosts: ["api-open.data.gov.sg"], timeoutMs: 1000 }, r3.deps), /not retried/);
  assert.equal(r3.calls.length, 1);
  const r4 = mock(() => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest" } }));
  await assert.rejects(safeGet("https://api-open.data.gov.sg/x", { allowedHosts: ["api-open.data.gov.sg"], timeoutMs: 1000 }, r4.deps), FetchRejected);
  const r5 = mock(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
  await assert.rejects(safeGet("https://api-open.data.gov.sg/x", { allowedHosts: ["api-open.data.gov.sg"], timeoutMs: 1000 }, r5.deps), /not on the verified allowlist/);
  for (const u of ["https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://user:pw@api-open.data.gov.sg/x", "https://api-open.data.gov.sg:8443/x"]) {
    await assert.rejects(safeGet(u, { allowedHosts: ["api-open.data.gov.sg", "localhost"], timeoutMs: 1000 }, r5.deps), FetchRejected, u);
  }
});

test("bulk download: truncation, size limit, wrong content type", async () => {
  const sink = () => {};
  const opts = { maxBytes: 100, deadlineMs: Date.now() + 10_000, now: Date.now };
  await assert.rejects(streamBody(new Response("x".repeat(10), { headers: { "Content-Length": "50", "Content-Type": "text/csv" } }), sink, opts), /truncated transfer/);
  await assert.rejects(streamBody(new Response("x".repeat(500), { headers: { "Content-Type": "text/csv" } }), sink, opts), /size limit/);
  await assert.rejects(streamBody(new Response("<html>", { headers: { "Content-Type": "text/html" } }), sink, opts), /unexpected content type/);
  assert.equal(await streamBody(new Response("a,b\n1,2\n", { headers: { "Content-Type": "text/csv" } }), sink, opts), 8);
});
