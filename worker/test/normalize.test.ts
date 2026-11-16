// Port of Stage 1 server/tests/test_normalize.py plus FTS-expression and similar-name cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nz from "../src/normalize.ts";

test("fold: diacritics, case, punctuation, NFKC", () => {
  assert.equal(nz.fold("Józefína  Ŝtrelvaq"), "jozefina strelvaq");
  assert.equal(nz.fold("O'Neil-Tan, José"), "o neil tan jose");
  assert.equal(nz.fold("ĀNANDA LOTUS"), "ananda lotus");
  assert.equal(nz.fold("Søren Łukasz"), "soren lukasz");
  assert.equal(nz.fold("ＦＵＬＬ　ＷＩＤＴＨ"), "full width");
});

test("fold keeps non-Latin scripts without transliterating", () => {
  assert.equal(nz.fold("Орло Вантрелл"), "орло вантрелл");
  assert.equal(nz.fold("陈大文"), "陈大文");
  assert.equal(nz.fold("محمد بن سلمان"), "محمد بن سلمان");
});

test("cleanInput strips controls and invisible characters", () => {
  assert.equal(nz.cleanInput("a\u0000b​c\n d"), "a b c d");
});

test("FTS expression: only quoted word tokens, generation-scoped", () => {
  const evil = ['"', 'a" OR "b', "NEAR(a b)", "a* -b", "col:val", "(x) AND y", "^start", "'; DROP TABLE x;--", "g : \"g1\"", "norm:x OR g:g2", "{g norm}: x"];
  for (const e of evil) {
    const q = nz.ftsQuery(e, 7);
    if (q === null) continue;
    assert.match(q, /^g : "g7" AND /);
    const rest = q.replace(/^g : "g7" AND /, "");
    for (const part of rest.split(" AND ")) assert.match(part, /^norm : "[\p{L}\p{N}]+"\*?$/u, `${e} -> ${q}`);
  }
  assert.equal(nz.ftsQuery("orlo van", 3), 'g : "g3" AND norm : "orlo" AND norm : "van"*');
  assert.equal(nz.ftsQuery("!!!", 3), null);
  assert.equal(nz.ftsQuery("", 3), null);
  assert.throws(() => nz.ftsQuery("x", -1));
  assert.throws(() => nz.ftsQuery("x", 1.5));
  const long = nz.ftsQuery("a".repeat(500) + " " + Array.from({ length: 30 }, (_, i) => "t" + i).join(" "), 1)!;
  assert.ok(long.split(" AND ").length <= nz.MAX_TOKENS + 1, "token count is capped");
  assert.ok(long.length < 1200, "expression length is bounded");
  assert.equal(nz.ftsQuery("Вантрелл", 2), 'g : "g2" AND norm : "вантрелл"*');
});

test("UEN formats keep text and leading zeroes", () => {
  assert.equal(nz.normalizeUen("t99dm 0001a"), "T99DM0001A");
  assert.equal(nz.normalizeUen("201912345K"), "201912345K");
  assert.equal(nz.normalizeUen("053123456A"), "053123456A");
  assert.equal(nz.normalizeUen("hello"), null);
  assert.equal(nz.normalizeUen("T99DM00001A"), null);
});

test("URL and domain normalization", () => {
  assert.equal(nz.normalizeUrl("HTTP://Login-Verify.EXAMPLE:80/secure/Account?id=1#frag"), "http://login-verify.example/secure/Account?id=1");
  assert.equal(nz.normalizeUrl("https://user:pw@example.com:443/"), "https://example.com/");
  assert.equal(nz.normalizeUrl("ftp://example.com/"), null);
  assert.equal(nz.normalizeUrl("javascript://example.com/%0aalert(1)"), null);
  assert.equal(nz.classifyIdentifier("malware-drop.test")?.type, "domain");
  assert.equal(nz.classifyIdentifier("T99DM0001A")?.type, "uen");
  assert.equal(nz.classifyIdentifier("http://a.example/x")?.type, "url");
  assert.equal(nz.classifyIdentifier("not an id"), null);
  assert.equal(nz.classifyIdentifier("münchen.example")?.value, "xn--mnchen-3ya.example");
});

test("partial dates stay partial", () => {
  assert.equal(nz.datePrecision("1968-04-12"), "day");
  assert.equal(nz.datePrecision("1975-09"), "month");
  assert.equal(nz.datePrecision("1981"), "year");
  assert.equal(nz.datePrecision("circa 1980"), null);
});

test("dangerous link schemes are never rendered as links", () => {
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "//evil.example/x",
    "file:///etc/passwd", "https://exa mple.com/", "http://\u0000evil.example/", " javascript:alert(1)", "https:///nohost"]) {
    assert.equal(nz.safeLink(bad), null, bad);
  }
  assert.equal(nz.safeLink("https://www.opensanctions.org/entities/x/"), "https://www.opensanctions.org/entities/x/");
});

test("defang", () => {
  assert.equal(nz.defang("http://login-verify.example/a.php"), "hxxp://login-verify[.]example/a[.]php");
});

test("similar-name: true positives", () => {
  assert.ok(nz.similarName("vantrll", "orlo vantrell"));          // 1 deletion
  assert.ok(nz.similarName("orlo vantrel", "orlo vantrell"));     // 1 deletion in 2nd token
  assert.ok(nz.similarName("severin aldak", "severin aldaq"));    // substitution
  assert.ok(nz.similarName("bartholomwe", "bartholomew"));        // transposition
});

test("similar-name: rejected cases (false-positive guards) and documented false negatives", () => {
  assert.ok(!nz.similarName("orlo vantrell", "orlo vantrell"), "exact matches belong to earlier tiers");
  assert.ok(!nz.similarName("lim", "tim"), "short tokens (< 4) must match exactly");
  assert.ok(!nz.similarName("tan wei", "tan mei"), "3-letter tokens are never fuzzed");
  assert.ok(!nz.similarName("vantrell", "ventrallo"), "more than 1 edit for a 8-char token... 2 allowed but this is 3");
  assert.ok(!nz.similarName("orlo vantrell", "orlo"), "every query token must be matched");
  assert.ok(!nz.similarName("ananda lotus", "lotus ananda holdings ananda"), "exact tokens only -> not 'similar'");
  assert.ok(!nz.similarName("person number 1050", "person number 1051"), "numeric tokens are never fuzzed");
  assert.ok(!nz.similarName("acme 2019", "acme 2018"));
  // Documented false negative: the candidate set is retrieved by a 3-letter prefix, so a typo in the
  // first three letters is not found by search (similarName itself would accept it).
  assert.ok(nz.similarName("vsntrell", "vantrell"));
});

test("editDistance cut-off is bounded", () => {
  assert.equal(nz.editDistance("abcdef", "abcdef", 1), 0);
  assert.equal(nz.editDistance("abcdef", "abdcef", 1), 1);
  assert.ok(nz.editDistance("a".repeat(60), "b".repeat(60), 2) > 2);
});
