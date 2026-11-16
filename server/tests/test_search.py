from checklah.search import Query, SearchService


def svc(demo_dir):
    return SearchService(demo_dir / "demo", "demo")


def captions(r):
    return [(x["id"], x["reason"]) for x in r["results"]]


def test_namesake_collision_returns_separate_records(demo_dir):
    r = svc(demo_dir).search(Query("Orlo Vantrell"))
    ids = [x["id"] for x in r["results"]]
    assert "demo-watchlist:DEMO-P-0001" in ids and "demo-watchlist:DEMO-P-0002" in ids
    assert all(x["reason"] == "Name/alias exact match" for x in r["results"])
    assert not any("score" in x or "confidence" in x or "_tier" in x for x in r["results"])


def test_pep_and_sanctions_are_separate_filters(demo_dir):
    s = svc(demo_dir)
    pep = {x["id"] for x in s.search(Query("Orlo Vantrell", topic="pep"))["results"]}
    sanc = {x["id"] for x in s.search(Query("Orlo Vantrell", topic="sanction"))["results"]}
    assert pep == {"demo-watchlist:DEMO-P-0002"}
    assert sanc == {"demo-watchlist:DEMO-P-0001"}
    both = s.search(Query("Severin Aldaq"))["results"][0]
    assert {t["class"] for t in both["topics"]} == {"pep", "sanction"}


def test_exact_uen_first_and_only_registry(demo_dir):
    r = svc(demo_dir).search(Query("t99dm0001a", mode="identifier"))
    assert captions(r) == [("demo-registry:T99DM0001A", "Exact UEN")]


def test_similar_names_in_different_sources_are_not_merged(demo_dir):
    r = svc(demo_dir).search(Query("vantrell trading", category="company"))
    ids = {x["id"] for x in r["results"]}
    assert {"demo-registry:T99DM0001A", "demo-watchlist:DEMO-C-0101"} <= ids
    reg = svc(demo_dir).record("demo-registry:T99DM0001A")
    assert reg["topics"] == []  # registry record never inherits watchlist topics


def test_alias_and_unicode(demo_dir):
    s = svc(demo_dir)
    r = s.search(Query("jozefina strelvaq"))
    assert r["results"][0]["id"] == "demo-watchlist:DEMO-P-0003"
    r = s.search(Query("Józefína"))
    assert r["results"][0]["id"] == "demo-watchlist:DEMO-P-0003"
    r = s.search(Query("Вантрелл"))
    assert r["results"][0]["id"] == "demo-watchlist:DEMO-P-0001"
    assert r["results"][0]["matched_name"] == "Орло Вантрелл"
    r = s.search(Query("ananda lotus"))
    assert r["results"][0]["id"] == "demo-registry:T99DM0003C"
    r = s.search(Query("ananda lotus investments"))  # previous name
    assert r["results"][0]["id"] == "demo-registry:T99DM0003C"


def test_prefix_tier_after_exact(demo_dir):
    r = svc(demo_dir).search(Query("vant"))
    assert r["total"] >= 4 and all(x["reason"] == "Name/alias prefix match" for x in r["results"])


def test_country_and_category_filters(demo_dir):
    s = svc(demo_dir)
    assert {x["id"] for x in s.search(Query("orlo", country="nz"))["results"]} == {"demo-watchlist:DEMO-P-0002"}
    assert s.search(Query("orlo", category="company"))["total"] == 0


def test_url_listing_scope_is_never_widened(demo_dir):
    s = svc(demo_dir)
    exact = s.search(Query("http://login-verify.example/secure/account?id=1", mode="identifier"))
    assert captions(exact) == [("demo-webfeed:DEMO-U-0001", "Exact URL listing")]
    other_path = s.search(Query("http://login-verify.example/other", mode="identifier"))
    assert other_path["total"] == 0  # a path-specific listing does not cover other paths
    domain = s.search(Query("login-verify.example", mode="identifier"))
    assert captions(domain) == [("demo-webfeed:DEMO-U-0001", "URL on this host (listing covers that URL only)")]
    host = s.search(Query("https://malware-drop.test/any/path", mode="identifier"))
    assert captions(host) == [("demo-webfeed:DEMO-U-0002", "Host listed by source")]


def test_malicious_and_invalid_input_is_inert(demo_dir):
    s = svc(demo_dir)
    for q in ['"', '" OR 1=1 --', "NEAR(orlo vantrell)", "orlo*", "*", "'; DROP TABLE entities; --", "\x00\x01",
              "a" * 500, "orlo OR severin", "-orlo", "names_fts:orlo"]:
        r = s.search(Query(q))
        assert isinstance(r["results"], list)
    assert {x["id"] for x in s.search(Query("orlo OR severin"))["results"]} == set()  # OR is literal text
    assert s.search(Query("not a uen", mode="identifier"))["notice"]
    assert s.search(Query("   ", mode="name"))["notice"]


def test_detail_masks_sensitive_and_filters_links(demo_dir):
    d = svc(demo_dir).record("demo-watchlist:DEMO-P-0001")
    pp = [i for i in d["identifiers"] if i["type"] == "passport"][0]
    assert pp["masked"] and pp["value"] is None
    assert "DEMO-PX-0001" not in str(d)
    assert "raw" not in d
    d4 = svc(demo_dir).record("demo-watchlist:DEMO-P-0004")
    assert all(l["url"].startswith("https://") for l in d4["links"])
    assert not any(x["type"] == "birth" for x in d4["dates"])  # never inferred
    probe = svc(demo_dir).record("demo-watchlist:DEMO-P-0999")
    assert probe["links"] == []  # data: and relative links dropped


def test_partial_dob_precision(demo_dir):
    s = svc(demo_dir)
    assert s.record("demo-watchlist:DEMO-P-0002")["dates"][0]["precision"] == "year"
    assert s.record("demo-watchlist:DEMO-P-0003")["dates"][0]["precision"] == "month"


def test_referent_resolves_and_unknown_is_none(demo_dir):
    s = svc(demo_dir)
    d = s.record("demo-watchlist:DEMO-C-0199")
    assert d["id"] == "demo-watchlist:DEMO-C-0102" and d["resolved_from"] == "demo-watchlist:DEMO-C-0199"
    assert s.record("demo-watchlist:NOPE") is None
    assert s.record("../../etc/passwd") is None
    assert s.record("opensanctions:Q1") is None  # live connector not loaded in demo mode


def test_categories_disabled_with_reason_and_live_sources_listed(demo_dir):
    src = svc(demo_dir).sources()
    cats = {c["id"]: c for c in src["categories"]}
    assert not cats["record"]["enabled"] and "Not connected" in cats["record"]["reason"]
    states = {s["id"]: s["state"] for s in src["sources"]}
    assert states["opensanctions"] == "not_loaded" and states["demo-webfeed"] == "stale"
    assert states["demo-watchlist"] == "connected"


def test_live_mode_never_loads_demo(demo_dir):
    live = SearchService(demo_dir / "live", "live")
    assert not any(cid.startswith("demo") for cid in live.stores)
    assert live.search(Query("Orlo Vantrell"))["total"] == 0
    assert live.record("demo-watchlist:DEMO-P-0001") is None
    assert not any(s["id"].startswith("demo") for s in live.sources()["sources"])
