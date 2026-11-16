// CheckLah UI. All upstream text goes through textContent / createTextNode: never innerHTML.
import "./style.css";

// ------------------------------------------------------------------ types
interface Tag { id: string; label: string; class: "sanction" | "pep" | "other" }
interface Result {
  id: string; caption: string; caption_defanged?: string; kind: string; schema: string; countries: string[];
  topics: Tag[]; datasets: string[]; source: { id: string; title: string }; reason: string;
  matched_name?: string; demo: boolean;
}
interface SearchResp {
  mode: string; results: Result[]; total: number; page: number; pages: number; notice?: string; capped?: boolean; identifier_type?: string;
  searched: { id: string; title: string; state: string }[];
  unavailable: { id: string; title: string; state: string; reason?: string }[];
  errors: { id: string; title: string; message: string }[];
}
interface Source {
  id: string; title: string; kinds: string[]; scope: string; state: string; reason?: string;
  licence: { name: string; url: string | null }; attribution: string; homepage: string | null; refresh: string;
  demo: boolean; imported_at?: string; upstream_exported_at?: string; upstream_version?: string; rows?: number;
  last_attempt?: string; last_success?: string; last_error?: string | null; last_error_at?: string | null;
  stale_reasons?: string[]; state_note?: string;
}
interface Category { id: string; label: string; enabled: boolean; reason?: string; sources: string[] }
interface SourcesResp { mode: string; sources: Source[]; categories: Category[]; countries: string[] }
interface Detail {
  id: string; resolved_from: string | null; kind: string; schema: string; caption: string; caption_defanged: string | null;
  names: { value: string; type: string }[]; countries: string[]; topics: Tag[];
  datasets: { id: string; title: string }[];
  identifiers: { type: string; label: string; value: string | null; masked: boolean; defanged?: string; scope?: string }[];
  dates: { type: string; label: string; value: string; precision: string | null }[];
  links: { label: string; url: string }[];
  properties: { key: string; label: string; value: string }[];
  provenance: { first_seen?: string; last_change?: string; published?: string };
  source: { id: string; title: string; state: string; stale_reasons: string[]; attribution: string;
            licence: { name: string; url: string | null }; imported_at?: string; upstream_exported_at?: string };
  demo: boolean;
}

// ------------------------------------------------------------------ helpers
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NOT_SUPPLIED = () => h("span", { class: "none" }, "Not supplied");

const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
function countryName(code: string): string {
  if (!/^[a-z]{2}$/i.test(code)) return code;
  try { return `${regionNames?.of(code.toUpperCase()) ?? code.toUpperCase()} (${code.toUpperCase()})`; } catch { return code.toUpperCase(); }
}
function fmtTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-SG", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
function fmtDate(value: string, precision: string | null): Node {
  if (precision === "day") return document.createTextNode(value);
  if (precision === "month") return h("span", {}, value, " ", h("span", { class: "small" }, "(partial: year and month only)"));
  if (precision === "year") return h("span", {}, value, " ", h("span", { class: "small" }, "(partial: year only)"));
  return h("span", {}, value, " ", h("span", { class: "small" }, "(as supplied)"));
}
const KIND_LABEL: Record<string, string> = { person: "Person", company: "Company", website: "Website listing", record: "Public record", other: "Entity" };
function tag(t: Tag): HTMLElement { return h("span", { class: `tag tag-${t.class}` }, t.label); }

// ------------------------------------------------------------------ API
let csrf = "";
let mode = "demo";
export const serverMode = () => mode;
class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { ...init.headers, "Content-Type": "application/json", "X-CheckLah-CSRF": csrf };
    init.body = JSON.stringify(body);
  }
  let r: Response;
  try { r = await fetch(path, init); } catch { throw new ApiError(0, "Could not reach the CheckLah server."); }
  let data: any = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new ApiError(401, "Sign in required."); }
  if (!r.ok) throw new ApiError(r.status, (data && typeof data.error === "string") ? data.error : `Request failed (${r.status}).`);
  return data as T;
}

// ------------------------------------------------------------------ theme
(function theme() {
  const KEY = "checklah-theme";
  const root = document.documentElement;
  const sync = () => document.querySelectorAll<HTMLButtonElement>("[data-theme-set]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.themeSet === (root.dataset.theme === "classic" ? "classic" : "legacy"))));
  document.addEventListener("click", e => {
    const b = (e.target as Element).closest?.("[data-theme-set]") as HTMLElement | null;
    if (!b) return;
    root.dataset.theme = b.dataset.themeSet === "classic" ? "classic" : "legacy";
    try { localStorage.setItem(KEY, root.dataset.theme); } catch { /* storage blocked */ }
    sync();
  });
  window.addEventListener("storage", e => { if (e.key === KEY) { root.dataset.theme = e.newValue === "classic" ? "classic" : "legacy"; sync(); } });
  sync();
})();

// ------------------------------------------------------------------ state
const state = {
  mode: "name" as "name" | "identifier",
  topic: "any",
  category: "all",
  page: 1,
  lastQuery: "",
  sources: null as SourcesResp | null,
  openId: null as string | null,
  opener: null as HTMLElement | null,
  results: null as SearchResp | null,
};

// ------------------------------------------------------------------ views
function showView(name: "login" | "search" | "sources") {
  for (const v of ["login", "search", "sources"]) $(`view-${v}`).hidden = v !== name;
  $("nav-search").toggleAttribute("aria-current", name === "search");
  if (name === "search") $("nav-search").setAttribute("aria-current", "page");
  $("nav-sources").toggleAttribute("aria-current", name === "sources");
  if (name === "sources") $("nav-sources").setAttribute("aria-current", "page");
  document.querySelector(".top-nav")!.toggleAttribute("hidden", name === "login");
}
function route() {
  if (!$("view-login").hidden) return;
  if (location.hash === "#/sources") { showView("sources"); renderSources(); $("sources-title").setAttribute("tabindex", "-1"); }
  else showView("search");
}
window.addEventListener("hashchange", route);

function showLogin() {
  closeDetail(false);
  showView("login");
  $("account").hidden = true;
  setTimeout(() => $("login-user").focus(), 0);
}

// ------------------------------------------------------------------ session
async function boot() {
  try {
    const s = await api<{ mode: string; auth: string; authenticated: boolean; user: string | null; csrf: string }>("/api/session");
    csrf = s.csrf; mode = s.mode;
    $("demo-banner").hidden = s.mode !== "demo";
    if (!s.authenticated) { showLogin(); return; }
    afterAuth(s.user);
  } catch (e) {
    showView("search");
    setState("error", "CheckLah server unavailable", [(e as Error).message]);
  }
}
async function afterAuth(user: string | null) {
  $("view-login").hidden = true;
  $("account").hidden = !user;
  $("account-user").textContent = user ?? "";
  route();
  await loadSources();
}
$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("login-error");
  err.hidden = true;
  try {
    const s = await api<{ user: string; csrf: string }>("/api/login", {
      username: ($("login-user") as HTMLInputElement).value, password: ($("login-pass") as HTMLInputElement).value });
    csrf = s.csrf;
    ($("login-pass") as HTMLInputElement).value = "";
    await afterAuth(s.user);
    $("q").focus();
  } catch (ex) {
    err.textContent = (ex as Error).message; err.hidden = false;
  }
});
$("logout").addEventListener("click", async () => {
  try { await api("/api/logout", {}); } catch { /* ignore */ }
  clearResults();
  const s = await api<{ csrf: string }>("/api/session").catch(() => null);
  if (s) csrf = s.csrf;
  showLogin();
});

// ------------------------------------------------------------------ sources + categories
async function loadSources() {
  try {
    state.sources = await api<SourcesResp>("/api/sources");
  } catch (e) {
    if ((e as ApiError).status === 401) return;
    setState("error", "Source list unavailable", [(e as Error).message]);
    return;
  }
  renderCategories();
  renderCountries();
  renderStale();
  renderAttribution();
  if (!$("view-sources").hidden) renderSources();
}

function renderCategories() {
  const s = state.sources!;
  const grid = $("cats"); grid.replaceChildren();
  const notes = $("cat-notes"); notes.replaceChildren();
  const all: Category = { id: "all", label: "All", enabled: true, sources: [] };
  for (const c of [all, ...s.categories]) {
    const b = h("button", { type: "button", class: "cat", "data-cat": c.id, "aria-pressed": String(state.category === c.id) }, c.label);
    if (!c.enabled) {
      b.disabled = true;
      b.setAttribute("aria-describedby", `cat-off-${c.id}`);
      b.append(h("span", { class: "cat-off" }, "Not connected"));
      notes.append(h("li", { id: `cat-off-${c.id}` }, `${c.label}: ${c.reason ?? "No connected source."} `, h("a", { href: "#/sources" }, "Sources")));
      if (state.category === c.id) state.category = "all";
    }
    b.addEventListener("click", () => {
      state.category = c.id;
      grid.querySelectorAll(".cat").forEach(x => x.setAttribute("aria-pressed", String((x as HTMLElement).dataset.cat === c.id)));
      if (state.lastQuery) runSearch(1);
    });
    grid.append(b);
  }
}
function renderCountries() {
  const sel = $("country") as HTMLSelectElement;
  const cur = sel.value;
  sel.replaceChildren(h("option", { value: "" }, "Any country"));
  const opts = state.sources!.countries.map(c => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n));
  for (const { c, n } of opts) sel.append(h("option", { value: c }, n));
  sel.value = opts.some(o => o.c === cur) ? cur : "";
}
function renderStale() {
  const box = $("stale"); box.replaceChildren();
  for (const s of state.sources!.sources) {
    if (s.state === "stale") box.append(h("div", { class: "banner", role: "note" },
      h("strong", {}, `${s.title} may be out of date: `), (s.stale_reasons ?? []).join("; ") + ". ",
      "Last upstream export ", fmtTime(s.upstream_exported_at) ?? "not supplied", ". ", h("a", { href: "#/sources" }, "Sources")));
    if (s.last_error && (s.state === "connected" || s.state === "stale")) box.append(h("div", { class: "banner", role: "note" },
      h("strong", {}, `${s.title}: `), "the last import attempt failed; the previous good snapshot is still in use. ", h("a", { href: "#/sources" }, "Sources")));
  }
}
function renderAttribution() {
  const live = state.sources!.sources.filter(s => s.state === "connected" || s.state === "stale");
  const el = $("foot-attrib");
  el.replaceChildren(h("strong", {}, "Source attribution: "));
  if (!live.length) { el.append("No sources connected."); return; }
  const attribs = [...new Set(live.map(s => s.attribution).filter(Boolean))];
  el.append(attribs.join(" "), " ", h("a", { href: "#/sources" }, "Sources and licences"));
}

function renderSources() {
  const body = $("sources-body");
  const s = state.sources;
  if (!s) { body.replaceChildren(h("p", { class: "lede" }, "Loading…")); return; }
  const groups: [string, (x: Source) => boolean, string][] = [
    ["Connected", x => x.state === "connected" || x.state === "stale", "Searched on every query."],
    ["Available, not imported", x => x.state === "not_imported", "Connector exists but no local snapshot yet. Not searched."],
    ["Not connected", x => x.state === "not_connected" || x.state === "not_loaded", "Not searched. A search returning nothing does not cover these."],
  ];
  const out: Node[] = [];
  if (s.mode === "demo") out.push(h("div", { class: "banner", role: "note" }, h("strong", {}, "Demo mode. "),
    "Only the fictional demo sources are loaded. Live connectors are listed with their current gate."));
  out.push(h("div", { class: "banner", role: "note" }, h("strong", {}, "Use restriction. "),
    "Personal, non-commercial hobby use only. OpenSanctions data is CC BY-NC 4.0: any use inside a for-profit business, including internal compliance, needs a data licence."));
  for (const [title, pred, desc] of groups) {
    const items = s.sources.filter(pred);
    if (!items.length) continue;
    out.push(h("section", { class: "src-group", "aria-label": title }, h("h2", {}, title), h("p", { class: "small" }, desc),
      h("div", { class: "src-grid" }, ...items.map(sourceCard))));
  }
  out.push(h("section", { class: "src-group", "aria-label": "Corrections" }, h("h2", {}, "Corrections"),
    h("p", { class: "lede" }, "CheckLah only shows what sources publish. If a record is wrong, contact the original publisher named on the record. CheckLah does not accept or publish reports about people or businesses.")));
  body.replaceChildren(...out);
}
function sourceCard(x: Source): HTMLElement {
  const stateText: Record<string, string> = { connected: "Connected", stale: "Stale", not_imported: "Not imported", not_connected: "Not connected", not_loaded: "Not loaded" };
  const pillClass = x.state === "connected" ? "connected" : x.state === "stale" ? "stale" : "";
  const dd = (v: string | null | undefined) => v ? h("dd", {}, v) : h("dd", {}, NOT_SUPPLIED());
  const rows: Node[] = [
    h("dt", {}, "Status"), h("dd", {}, h("span", { class: `state-pill ${pillClass}` }, stateText[x.state] ?? x.state),
      x.demo ? " " : "", x.demo ? h("span", { class: "tag tag-demo" }, "Fictional") : ""),
    h("dt", {}, "Covers"), h("dd", {}, x.kinds.map(k => KIND_LABEL[k] ?? k).join(", ")),
    h("dt", {}, "Licence"), h("dd", {}, x.licence.url ? h("a", { href: x.licence.url, rel: "noopener noreferrer", target: "_blank", referrerpolicy: "no-referrer", class: "ext" }, x.licence.name) : x.licence.name),
  ];
  if (x.homepage) rows.push(h("dt", {}, "Docs"), h("dd", {}, h("a", { href: x.homepage, rel: "noopener noreferrer", target: "_blank", referrerpolicy: "no-referrer", class: "ext" }, "Official source page")));
  if (x.state === "connected" || x.state === "stale" || x.state === "not_imported") {
    rows.push(
      h("dt", {}, "Last upstream export"), dd(fmtTime(x.upstream_exported_at)),
      h("dt", {}, "Last local import"), dd(fmtTime(x.imported_at)),
      h("dt", {}, "Last attempt"), dd(fmtTime(x.last_attempt)),
      h("dt", {}, "Last error"), x.last_error ? h("dd", { class: "msg-error" }, x.last_error) : h("dd", {}, "None"),
      h("dt", {}, "Records"), dd(x.rows != null ? x.rows.toLocaleString("en-SG") : null),
    );
    if (x.stale_reasons?.length) rows.push(h("dt", {}, "Stale because"), h("dd", {}, x.stale_reasons.join("; ")));
  }
  if (x.refresh) rows.push(h("dt", {}, "Refresh"), h("dd", {}, x.refresh));
  return h("article", { class: "src box" }, h("h3", {}, x.title), h("p", {}, x.scope),
    x.reason && x.state !== "connected" ? h("p", { class: "small" }, h("strong", {}, "Why: "), x.reason) : null,
    h("dl", { class: "dl" }, ...rows),
    x.attribution ? h("p", { class: "small" }, h("strong", {}, "Attribution: "), x.attribution) : null);
}

// ------------------------------------------------------------------ search form
const q = $("q") as HTMLInputElement;
const MODE_TEXT = {
  name: { label: "Name or company", hint: "People, companies and aliases. Text match only.", placeholder: "" },
  identifier: { label: "UEN, URL or domain", hint: "Exact Singapore UEN, URL or domain, as the source lists it. Never fetched.", placeholder: "" },
};
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(b => b.addEventListener("click", () => {
  state.mode = b.dataset.mode as "name" | "identifier";
  document.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("q-label").textContent = MODE_TEXT[state.mode].label;
  $("mode-hint").textContent = MODE_TEXT[state.mode].hint;
  q.focus();
}));
document.querySelectorAll<HTMLButtonElement>("[data-topic]").forEach(b => b.addEventListener("click", () => {
  state.topic = b.dataset.topic!;
  document.querySelectorAll("[data-topic]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  if (state.lastQuery) runSearch(1);
}));
$("country").addEventListener("change", () => { if (state.lastQuery) runSearch(1); });
q.addEventListener("input", () => { $("q-clear").hidden = !q.value; });
$("q-clear").addEventListener("click", () => { q.value = ""; $("q-clear").hidden = true; clearResults(); q.focus(); });
$("search-form").addEventListener("submit", e => { e.preventDefault(); state.lastQuery = q.value; runSearch(1); });
$("prev").addEventListener("click", () => runSearch(state.page - 1));
$("next").addEventListener("click", () => runSearch(state.page + 1));

function clearResults() {
  state.lastQuery = ""; state.results = null;
  $("results").replaceChildren(); $("status").textContent = ""; $("state").hidden = true; $("pager").hidden = true;
  closeDetail(false);
}
function setState(kind: "empty" | "error" | "notice" | "loading", title: string, lines: (string | Node)[] = []) {
  const el = $("state");
  el.className = `state${kind === "error" ? " state-error" : ""}`;
  el.replaceChildren(h("h2", {}, title), ...lines.map(l => h("p", {}, l)));
  el.hidden = false;
}

let seq = 0;
async function runSearch(page: number) {
  const text = state.lastQuery.trim();
  if (!text) { clearResults(); setState("notice", "Enter a name, company, UEN, URL or domain."); return; }
  const my = ++seq;
  closeDetail(false);
  $("results").replaceChildren(); $("pager").hidden = true;
  $("results").setAttribute("aria-busy", "true");
  setState("loading", "Searching connected sources…");
  $("status").textContent = "Searching…";
  let r: SearchResp;
  try {
    r = await api<SearchResp>("/api/search", { q: text, mode: state.mode, category: state.category,
      country: ($("country") as HTMLSelectElement).value, topic: state.topic, page });
  } catch (e) {
    if (my !== seq) return;
    $("results").removeAttribute("aria-busy");
    $("status").textContent = "";
    setState("error", "Search failed", [(e as Error).message, "This is an error, not a no-match result."]);
    return;
  }
  if (my !== seq) return;
  state.results = r; state.page = r.page;
  $("results").removeAttribute("aria-busy");
  renderResults(r);
}

function renderResults(r: SearchResp) {
  const list = $("results");
  $("state").hidden = true;
  const extra: Node[] = [];
  if (r.errors.length) extra.push(h("ul", {}, ...r.errors.map(e => h("li", {}, `${e.title}: ${e.message}`))));
  if (r.notice) {
    $("status").textContent = "";
    setState("notice", r.notice);
    return;
  }
  if (!r.searched.length && !r.errors.length) {
    $("status").textContent = "";
    setState("notice", "No connected source covers this search.",
      ["Nothing was searched, so this is not a no-match result.", h("a", { href: "#/sources" }, "See Sources")]);
    return;
  }
  const searched = r.searched.map(s => s.title).join(", ");
  if (r.errors.length) {
    setState("error", "Some sources could not be searched", ["Results below exclude them. Missing results here are not a no-match.", ...extra]);
  }
  if (r.total === 0) {
    const el = $("state");
    if (!r.errors.length) {
      setState("empty", "No matches in the connected sources.",
        ["This is not proof of a clean record or a safe transaction.", `Searched: ${searched}.`,
         r.unavailable.length ? `Not searched: ${r.unavailable.map(u => u.title).join(", ")}.` : ""]);
    }
    el.hidden = false;
    $("status").textContent = "0 candidates.";
    return;
  }
  $("status").textContent = `${r.total} candidate${r.total === 1 ? "" : "s"} from ${r.searched.length} connected source${r.searched.length === 1 ? "" : "s"} (${searched}). ${r.identifier_type ? "A listing or registry entry is not a verdict." : "A name match is not an identity match."}`;
  if (r.capped) $("status").textContent += ` Capped at ${200} candidates per source: add more of the name or a filter to narrow it.`;
  list.replaceChildren(...r.results.map(resultRow));
  const pager = $("pager");
  pager.hidden = r.pages <= 1;
  $("page-info").textContent = `Page ${r.page} of ${r.pages}`;
  ($("prev") as HTMLButtonElement).disabled = r.page <= 1;
  ($("next") as HTMLButtonElement).disabled = r.page >= r.pages;
}

function resultRow(x: Result): HTMLElement {
  const title = x.kind === "website" ? h("span", { class: "defanged" }, x.caption_defanged ?? x.caption) : x.caption;
  const btn = h("button", { type: "button", class: "btn-quiet", "aria-label": `Review record: ${x.caption}` }, "Review record");
  btn.addEventListener("click", () => openDetail(x, btn));
  const meta = [KIND_LABEL[x.kind] ?? x.kind, x.countries.length ? x.countries.map(c => c.toUpperCase()).join(", ") : "Country not supplied"].join(" · ");
  return h("li", { class: `res${state.openId === x.id ? " is-open" : ""}`, "data-id": x.id },
    h("div", { class: "res-name" }, title,
      x.matched_name ? h("span", { class: "alias" }, "Matched: ", x.matched_name) : null,
      h("span", { class: "res-why" }, x.reason)),
    h("div", { class: "res-meta" }, meta),
    h("div", { class: "res-tags" }, ...x.topics.map(tag), h("span", { class: "tag tag-source" }, x.source.title), x.demo ? h("span", { class: "tag tag-demo" }, "DEMO") : null),
    h("div", { class: "res-action" }, btn));
}

// ------------------------------------------------------------------ detail
const detail = $("detail");
function closeDetail(restoreFocus = true) {
  if (detail.hidden) return;
  detail.hidden = true; detail.replaceChildren();
  document.querySelector(".results-wrap")!.classList.remove("has-detail");
  document.body.classList.remove("detail-open");
  document.querySelectorAll(".res.is-open").forEach(r => r.classList.remove("is-open"));
  state.openId = null;
  if (restoreFocus && state.opener?.isConnected) state.opener.focus();
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && !detail.hidden) { e.preventDefault(); closeDetail(); } });

async function openDetail(x: Result, opener: HTMLElement) {
  state.opener = opener; state.openId = x.id;
  document.querySelectorAll(".res").forEach(r => r.classList.toggle("is-open", (r as HTMLElement).dataset.id === x.id));
  document.querySelector(".results-wrap")!.classList.add("has-detail");
  if (matchMedia("(max-width: 960px)").matches) document.body.classList.add("detail-open");
  detail.hidden = false;
  detail.replaceChildren(detailHead(x.caption, x.kind, x.caption_defanged), h("div", { class: "d-body" }, h("p", { class: "small" }, "Loading record…")));
  let d: Detail;
  try {
    d = await api<Detail>(`/api/record/${encodeURIComponent(x.id)}`);
  } catch (e) {
    if (state.openId !== x.id) return;
    detail.replaceChildren(detailHead(x.caption, x.kind, x.caption_defanged), h("div", { class: "d-body" }, h("p", { class: "msg msg-error", role: "alert" }, (e as Error).message)));
    ($("d-title") as HTMLElement).focus();
    return;
  }
  if (state.openId !== x.id) return;
  detail.replaceChildren(detailHead(d.caption, d.kind, d.caption_defanged), detailBody(d, x));
  ($("d-title") as HTMLElement).focus();
}
function detailHead(caption: string, kind: string, defanged?: string | null): HTMLElement {
  const close = h("button", { type: "button", class: "btn-quiet", "aria-label": "Close record" }, "Close");
  close.addEventListener("click", () => closeDetail());
  return h("div", { class: "d-head" },
    h("div", { class: "d-head-text" }, h("div", { class: "d-kind" }, KIND_LABEL[kind] ?? kind),
      h("h2", { class: "d-title", id: "d-title", tabindex: "-1" }, kind === "website" ? h("span", { class: "defanged" }, defanged ?? caption) : caption)),
    close);
}
function section(title: string, ...kids: Child[]): HTMLElement { return h("section", { class: "d-sec" }, h("h3", {}, title), ...kids); }
function dl(rows: [string, Node | string | null][]): HTMLElement {
  const el = h("dl", { class: "dl" });
  for (const [k, v] of rows) el.append(h("dt", {}, k), h("dd", {}, v === null || v === "" ? NOT_SUPPLIED() : v));
  return el;
}
function extLink(url: string, label: string): HTMLElement {
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow", referrerpolicy: "no-referrer", class: "ext" }, label);
}
function detailBody(d: Detail, x: Result): HTMLElement {
  const warn = d.kind === "person" ? "This record may refer to a different person. Compare identifiers and the original source."
    : d.kind === "company" ? "This record may refer to a different company. Compare identifiers such as the UEN and the original source."
    : d.kind === "website" ? "A listing applies only to the scope the source states. It is not a verdict on the site, its owner or other pages."
    : "This record may refer to someone else. Compare identifiers and the original source.";
  const primary = d.names.filter(n => n.type === "primary").map(n => n.value);
  const aliases = d.names.filter(n => n.type !== "primary");
  const aliasLabel: Record<string, string> = { alias: "Alias", weak_alias: "Weak alias", previous: "Previous name" };
  const isPep = d.topics.some(t => t.class === "pep");
  const body = h("div", { class: "d-body" },
    d.demo ? h("p", { class: "d-warn" }, h("strong", {}, "FICTIONAL DEMO RECORD. "), "Invented for testing; describes no real person, business or website.") : null,
    h("p", { class: "d-warn", role: "note" }, warn),
    d.resolved_from ? h("p", { class: "small" }, `The ID ${d.resolved_from} was merged into ${d.id} by the source.`) : null,
    section("Why this appears", h("p", { class: "small" }, x.reason, x.matched_name ? ` — matched “${x.matched_name}”` : "", ". Text and identifiers only; no identity confirmation.")),
    d.topics.length ? section("Source topics", h("div", { class: "res-tags" }, ...d.topics.map(tag)),
      isPep ? h("p", { class: "small" }, "PEP means a public role or connection to one. It is not an allegation of wrongdoing.") : null) : null,
    section("Record", dl([
      ["Entity type", `${KIND_LABEL[d.kind] ?? d.kind} (${d.schema})`],
      ["Name", primary.length ? primary.join(" / ") : null],
      ["Aliases", aliases.length ? h("ul", { class: "list" }, ...aliases.map(a => h("li", {}, a.value, " ", h("span", { class: "small" }, `(${aliasLabel[a.type] ?? a.type})`)))) : null],
      ["Countries", d.countries.length ? d.countries.map(countryName).join(", ") : null],
      ...d.dates.map(dt => [dt.label, fmtDate(dt.value, dt.precision)] as [string, Node]),
      ...(d.kind === "person" && !d.dates.some(x => x.type === "birth") ? [["Date of birth", null] as [string, null]] : []),
      ...d.properties.map(p => [p.label, p.value] as [string, string]),
    ])),
    section("Identifiers", d.identifiers.length ? dl(d.identifiers.map(i => [i.label,
      i.masked ? h("span", { class: "small" }, "Supplied by source; masked by CheckLah")
      : i.defanged ? h("span", {}, h("span", { class: "defanged" }, i.defanged), i.scope ? h("span", { class: "small" }, ` (scope: ${i.scope === "exact_url" ? "this exact URL" : i.scope === "host" ? "whole host" : i.scope})`) : "")
      : (i.value ?? null)] as [string, Node | string | null])) : h("p", { class: "small" }, "No identifiers supplied by the source.")),
    section("Source", dl([
      ["Source", d.source.title],
      ["Datasets", d.datasets.length ? h("ul", { class: "list" }, ...d.datasets.map(ds => h("li", {}, ds.title || ds.id))) : null],
      ["Original source", d.links.length ? h("ul", { class: "list" }, ...d.links.map(l => h("li", {}, extLink(l.url, l.label)))) : null],
      ["Source status", d.source.state === "stale" ? `Stale: ${d.source.stale_reasons.join("; ")}` : d.source.state === "connected" ? "Connected" : d.source.state],
      ["First seen by source", d.provenance.first_seen ?? null],
      ["Last changed at source", d.provenance.last_change ?? null],
      ["Upstream export", fmtTime(d.source.upstream_exported_at)],
      ["Retrieved locally", fmtTime(d.source.imported_at)],
      ["Licence", d.source.licence.url ? extLink(d.source.licence.url, d.source.licence.name) : d.source.licence.name],
      ["Attribution", d.source.attribution || null],
    ])),
    section("Corrections", h("p", { class: "small" }, "If this record is wrong, contact the original publisher above. CheckLah does not accept or publish reports.")),
  );
  return body;
}

boot();
