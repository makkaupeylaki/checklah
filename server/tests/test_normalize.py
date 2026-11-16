from checklah import normalize as nz


def test_fold_diacritics_case_punctuation():
    assert nz.fold("Józefína  Ŝtrelvaq") == "jozefina strelvaq"
    assert nz.fold("O'Neil-Tan, José") == "o neil tan jose"
    assert nz.fold("ĀNANDA LOTUS") == "ananda lotus"
    assert nz.fold("Søren Łukasz") == "soren lukasz"
    assert nz.fold("ＦＵＬＬ　ＷＩＤＴＨ") == "full width"  # NFKC


def test_fold_keeps_non_latin_scripts_without_transliterating():
    assert nz.fold("Орло Вантрелл") == "орло вантрелл"
    assert nz.fold("陈大文") == "陈大文"


def test_clean_input_strips_controls_and_invisible():
    assert nz.clean_input("a\x00b​c\n d") == "a b c d"


def test_fts_query_is_always_quoted_tokens():
    for evil in ['"', 'a" OR "b', "NEAR(a b)", "a* -b", "col:val", "(x) AND y", "^start", "'; DROP TABLE x;--"]:
        q = nz.fts_query(evil)
        if q is None:
            continue
        for part in q.split(" "):
            assert part.startswith('"') and (part.endswith('"') or part.endswith('"*')), q
            assert part.strip('"*').isalnum() or part.strip('"*').replace("_", "").isalnum(), q
    assert nz.fts_query("orlo van") == '"orlo" "van"*'
    assert nz.fts_query("!!!") is None


def test_uen_formats():
    assert nz.normalize_uen("t99dm 0001a") == "T99DM0001A"
    assert nz.normalize_uen("201912345K") == "201912345K"
    assert nz.normalize_uen("53123456A") == "53123456A"
    assert nz.normalize_uen("hello") is None
    assert nz.normalize_uen("T99DM00001A") is None


def test_url_and_domain():
    assert nz.normalize_url("HTTP://Login-Verify.EXAMPLE:80/secure/Account?id=1#frag") == \
        "http://login-verify.example/secure/Account?id=1"
    assert nz.normalize_url("https://user:pw@example.com:443/") == "https://example.com/"
    assert nz.normalize_url("ftp://example.com/") is None
    assert nz.normalize_url("javascript://example.com/%0aalert(1)") is None
    assert nz.classify_identifier("malware-drop.test").type == "domain"
    assert nz.classify_identifier("T99DM0001A").type == "uen"
    assert nz.classify_identifier("http://a.example/x").type == "url"
    assert nz.classify_identifier("not an id") is None
    assert nz.classify_identifier("münchen.example").value == "xn--mnchen-3ya.example"


def test_partial_dates():
    assert nz.date_precision("1968-04-12") == "day"
    assert nz.date_precision("1975-09") == "month"
    assert nz.date_precision("1981") == "year"
    assert nz.date_precision("circa 1980") is None


def test_dangerous_link_schemes_rejected():
    for bad in ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "/relative",
                "//evil.example/x", "file:///etc/passwd", "https://exa mple.com/", "http://\x00evil.example/",
                " javascript:alert(1)", "https:///nohost"]:
        assert nz.safe_link(bad) is None, bad
    assert nz.safe_link("https://www.opensanctions.org/entities/x/") == "https://www.opensanctions.org/entities/x/"


def test_defang():
    assert nz.defang("http://login-verify.example/a.php") == "hxxp://login-verify[.]example/a[.]php"
