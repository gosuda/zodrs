#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::ref_option,
    clippy::unreadable_literal
)]

//! Table-driven integration tests for the zodrs Rust validation core.
//!
//! Every `#[case]` is a row in a `rstest` table: valid (asserting the status),
//! invalid (asserting the exact issue object: code, fields, and path), and the
//! dirty-flag cases (strip / default / trim / key reorder). Column data
//! re-serializes with `serde_json` only to express multi-digit numbers.

use rstest::rstest;
use serde_json::{Value as Json, json};
use zodrs::{compile, validate};

fn plan(plan_json: &Json) -> zodrs::CompiledPlan {
    let s = serde_json::to_string(plan_json).unwrap();
    compile(&s).expect("plan compiles")
}

fn issues(payload: &Option<String>) -> Vec<Json> {
    serde_json::from_str(payload.as_deref().expect("issue payload")).expect("issues parse")
}

fn assert_issue(verdict: &zodrs::Verdict, expected: &Json) {
    assert_eq!(verdict.status, 2, "expected invalid verdict: {verdict:?}");
    let got = issues(&verdict.payload);
    assert_eq!(got, vec![expected.clone()], "issue mismatch");
}

fn output(verdict: &zodrs::Verdict) -> Json {
    assert_eq!(verdict.status, 1, "expected rewritten verdict");
    serde_json::from_str(verdict.payload.as_deref().unwrap()).unwrap()
}

// ------------------------------------------------------------------------
// Round-trip: object{a: string.min(3), b: array(number.int)} compiles to
// the expected 4-node arena.
// ------------------------------------------------------------------------

#[test]
fn round_trip_object_string_min_array_int() {
    let plan_json = json!([
        {"k":"object","keys":["a","b"],"values":[1,3],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[{"c":"min_length","v":3}]},
        {"k":"number","checks":[{"c":"number_format","v":"int32"}]},
        {"k":"array","element":2,"checks":[]}
    ]);
    let compiled = plan(&plan_json);
    assert_eq!(compiled.nodes().len(), 4);
    assert_eq!(compiled.root(), 0);
    assert!(compiled.json_eligible);
}

// ------------------------------------------------------------------------
// Scalars
// ------------------------------------------------------------------------

#[rstest]
#[case(json!({"k":"string","checks":[]}), json!("hello"), 0)]
#[case(json!({"k":"string","checks":[{"c":"min_length","v":3}]}), json!("hello"), 0)]
#[case(json!({"k":"number","checks":[]}), json!(36), 0)]
#[case(json!({"k":"number","checks":[{"c":"gt","v":10,"inclusive":false}]}), json!(36), 0)]
#[case(json!({"k":"boolean"}), json!(true), 0)]
#[case(json!({"k":"null"}), Json::Null, 0)]
#[case(json!({"k":"any"}), json!([1,2,3]), 0)]
#[case(json!({"k":"unknown"}), json!({"x":1}), 0)]
#[case(json!({"k":"literal","values":["red",1,true,null]}), json!("red"), 0)]
#[case(json!({"k":"literal","values":["red",1,true,null]}), json!(1), 0)]
#[case(json!({"k":"enum","values":["open","closed"]}), json!("open"), 0)]
#[case(json!({"k":"string","checks":[{"c":"length","v":3}]}), json!("abc"), 0)]
fn scalar_valid(#[case] node: Json, #[case] input: Json, #[case] status: u8) {
    let compiled = plan(&json!([node]));
    let bytes = serde_json::to_vec(&input).unwrap();
    let verdict = validate(&compiled, &bytes);
    assert_eq!(verdict.status, status, "{verdict:?}");
}

#[rstest]
// wrong type for string
#[case(
    json!({"k":"string","checks":[]}), json!(36),
    json!({"code":"invalid_type","expected":"string","path":[]})
)]
// string min_length fail
#[case(
    json!({"k":"string","checks":[{"c":"min_length","v":3}]}), json!("Ad"),
    json!({"code":"too_small","origin":"string","minimum":3,"inclusive":true,"path":[]})
)]
// string max_length fail
#[case(
    json!({"k":"string","checks":[{"c":"max_length","v":2}]}), json!("abc"),
    json!({"code":"too_big","origin":"string","maximum":2,"inclusive":true,"path":[]})
)]
// exact length too small
#[case(
    json!({"k":"string","checks":[{"c":"length","v":5}]}), json!("abc"),
    json!({"code":"too_small","origin":"string","minimum":5,"inclusive":true,"exact":true,"path":[]})
)]
// wrong type for number
#[case(
    json!({"k":"number","checks":[]}), json!("x"),
    json!({"code":"invalid_type","expected":"number","path":[]})
)]
// gt exclusive fail
#[case(
    json!({"k":"number","checks":[{"c":"gt","v":10,"inclusive":false}]}), json!(10),
    json!({"code":"too_small","origin":"number","minimum":10,"inclusive":false,"path":[]})
)]
// gt inclusive pass boundary -> moved to valid table above; here lte fail
#[case(
    json!({"k":"number","checks":[{"c":"lt","v":5,"inclusive":true}]}), json!(6),
    json!({"code":"too_big","origin":"number","maximum":5,"inclusive":true,"path":[]})
)]
// multiple_of fail
#[case(
    json!({"k":"number","checks":[{"c":"multiple_of","v":5}]}), json!(36),
    json!({"code":"not_multiple_of","origin":"number","divisor":5,"path":[]})
)]
// literal miss
#[case(
    json!({"k":"literal","values":["red"]}), json!("blue"),
    json!({"code":"invalid_value","values":["red"],"path":[]})
)]
// enum miss
#[case(
    json!({"k":"enum","values":["open","closed"]}), json!("pending"),
    json!({"code":"invalid_value","values":["open","closed"],"path":[]})
)]
// boolean type fail
#[case(
    json!({"k":"boolean"}), json!(1),
    json!({"code":"invalid_type","expected":"boolean","path":[]})
)]
// null type fail
#[case(
    json!({"k":"null"}), json!(0),
    json!({"code":"invalid_type","expected":"null","path":[]})
)]
// int32 format: non-integer
#[case(
    json!({"k":"number","checks":[{"c":"number_format","v":"int32"}]}), json!(1.5),
    json!({"code":"invalid_type","expected":"int","format":"int32","path":[]})
)]
// int32 format: out of range
#[case(
    json!({"k":"number","checks":[{"c":"number_format","v":"int32"}]}), json!(3_000_000_000_f64),
    json!({"code":"too_big","origin":"number","maximum":2147483647,"inclusive":true,"path":[]})
)]
fn scalar_invalid(#[case] node: Json, #[case] input: Json, #[case] expected: Json) {
    let compiled = plan(&json!([node]));
    let bytes = serde_json::to_vec(&input).unwrap();
    let verdict = validate(&compiled, &bytes);
    assert_issue(&verdict, &expected);
}

// ------------------------------------------------------------------------
// Formats
// ------------------------------------------------------------------------

#[rstest]
#[case("email", json!("ada@example.com"), true)]
#[case("email", json!("nope"), false)]
#[case("email", json!(".a@b.com"), false)]
#[case("email", json!("a..b@c.com"), false)]
#[case("uuid", json!("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), true)]
#[case("uuid", json!("not-a-uuid"), false)]
#[case("uuid", json!("00000000-0000-0000-0000-000000000000"), true)]
#[case("cuid", json!("ckj2q3w4a0000xyzp9q8s2d3f"), true)]
#[case("cuid2", json!("pfh0daxfpwhzpvsnxt6a9o6f"), true)]
#[case("ulid", json!("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true)]
#[case("ulid", json!("01ARZ3NDEKTSV4RRFFQ69G5FAU"), false)] // 'U' excluded
#[case("nanoid", json!("V1StGXR8_Z5jHiD8P2s9m"), true)]
#[case("ipv4", json!("192.168.1.1"), true)]
#[case("ipv4", json!("256.1.1.1"), false)]
#[case("ipv6", json!("::1"), true)]
#[case("ipv6", json!("2001:db8::ff00:42:8329"), true)]
#[case("mac", json!("00:1A:2B:3C:4D:5E"), true)]
#[case("mac", json!("00:1a:2b:3c:4d:5e"), true)]
#[case("cidrv4", json!("192.168.1.0/24"), true)]
#[case("cidrv4", json!("192.168.1.0/33"), false)]
#[case("base64", json!("aGVsbG8="), true)]
#[case("base64", json!("aGVsbG8"), false)] // not a multiple of 4 with padding
#[case("base64url", json!("aGVsbG8"), true)]
#[case("base64url", json!("aGVsbG8="), false)]
#[case("e164", json!("+14155552671"), true)]
#[case("e164", json!("14155552671"), false)]
#[case("hex", json!("deadbeef"), true)]
#[case("hex", json!("deadbeefz"), false)]
#[case("lowercase", json!("hello"), true)]
#[case("lowercase", json!("Hello"), false)]
#[case("uppercase", json!("HELLO"), true)]
#[case("uppercase", json!("hELLO"), false)]
#[case("hostname", json!("example.com"), true)]
#[case("hostname", json!("a.b.c.d"), true)]
#[case("hostname", json!("example.com."), true)]
#[case("hostname", json!("-bad.com"), false)]
#[case("hostname", json!("bad-.com"), false)]
#[case("duration", json!("P1Y2M3DT4H5M6S"), true)]
#[case("duration", json!("P2W"), true)]
#[case("duration", json!("PT1H"), true)]
#[case("duration", json!("P"), false)]
#[case("extendedDuration", json!("+P1Y2M3DT4H5M6.5S"), true)]
#[case("date", json!("2024-02-29"), true)] // leap year
#[case("date", json!("2023-02-29"), false)] // not a leap year
#[case("date", json!("2024-13-01"), false)]
#[case("time", json!("14:30"), true)]
#[case("time", json!("14:30:59"), true)]
#[case("time", json!("24:00"), false)]
#[case("datetime", json!("2024-02-29T14:30:00Z"), true)]
#[case("datetime", json!("2023-02-29T14:30:00Z"), false)]
#[case("md5_hex", json!("5d41402abc4b2a76b9719d911017c592"), true)]
#[case("sha256_hex", json!("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"), true)]
fn format_checks(#[case] format: &str, #[case] input: Json, #[case] ok: bool) {
    let node = json!({"k":"string","checks":[{"c":"format","v":format}]});
    let compiled = plan(&json!([node]));
    let bytes = serde_json::to_vec(&input).unwrap();
    let verdict = validate(&compiled, &bytes);
    if ok {
        assert_eq!(
            verdict.status, 0,
            "expected valid for {format} {input}: {verdict:?}"
        );
    } else {
        assert_eq!(verdict.status, 2, "expected invalid for {format} {input}");
        let iss = issues(&verdict.payload);
        assert_eq!(iss[0]["code"], json!("invalid_format"));
        assert_eq!(iss[0]["format"], json!(format));
    }
}

// ------------------------------------------------------------------------
// String keyword checks
// ------------------------------------------------------------------------

#[rstest]
#[case("starts_with", "starts_with", "abc-xyz", json!("abc"), true)]
#[case("starts_with", "starts_with", "abc-xyz", json!("xyz"), false)]
#[case("ends_with", "ends_with", "abc-xyz", json!("xyz"), true)]
#[case("ends_with", "ends_with", "abc-xyz", json!("abc"), false)]
#[case("includes", "includes", "abc-xyz", json!("c-x"), true)]
#[case("includes", "includes", "abc-xyz", json!("zz"), false)]
fn string_keywords(
    #[case] c: &str,
    #[case] format: &str,
    #[case] input: &str,
    #[case] needle: Json,
    #[case] ok: bool,
) {
    let node = json!({"k":"string","checks":[{"c":c,"v":needle}]});
    let compiled = plan(&json!([node]));
    let bytes = serde_json::to_vec(&json!(input)).unwrap();
    let verdict = validate(&compiled, &bytes);
    assert_eq!(verdict.status, if ok { 0 } else { 2 });
    if !ok {
        let iss = issues(&verdict.payload);
        assert_eq!(iss[0]["format"], json!(format));
    }
}

// ------------------------------------------------------------------------
// Objects: valid, invalid, strict, and the dirty-flag cases.
// ------------------------------------------------------------------------

fn user_plan() -> zodrs::CompiledPlan {
    plan(&json!([
        {"k":"object","keys":["name","age"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[{"c":"min_length","v":3}]},
        {"k":"number","checks":[{"c":"gt","v":0,"inclusive":false}]}
    ]))
}

#[test]
fn object_valid_clean() {
    let v = validate(&user_plan(), br#"{"name":"Ada","age":36}"#);
    assert_eq!(v.status, 0, "{v:?}");
}

#[test]
fn object_invalid_nested_path() {
    let v = validate(&user_plan(), br#"{"name":"Ad","age":36}"#);
    assert_issue(
        &v,
        &json!({"code":"too_small","origin":"string","minimum":3,"inclusive":true,"path":["name"]}),
    );
}

#[test]
fn object_missing_required_key() {
    let v = validate(&user_plan(), br#"{"name":"Ada"}"#);
    assert_issue(
        &v,
        &json!({"code":"invalid_type","expected":"number","path":["age"]}),
    );
}

// dirty: unknown key stripped
#[test]
fn object_strip_unknown_sets_dirty() {
    let v = validate(&user_plan(), br#"{"name":"Ada","age":36,"extra":1}"#);
    assert_eq!(v.status, 1);
    assert_eq!(output(&v), json!({"name":"Ada","age":36}));
}

// dirty: input key order differs from schema order
#[test]
fn object_key_reorder_sets_dirty() {
    let v = validate(&user_plan(), br#"{"age":36,"name":"Ada"}"#);
    assert_eq!(v.status, 1);
    assert_eq!(output(&v), json!({"name":"Ada","age":36}));
}

// dirty: default applied for a missing key
#[test]
fn object_default_applied_sets_dirty() {
    let compiled = plan(&json!([
        {"k":"object","keys":["name","role"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[]},
        {"k":"default","inner":3,"value":"user"},
        {"k":"string","checks":[]}
    ]));
    let v = validate(&compiled, br#"{"name":"Ada"}"#);
    assert_eq!(v.status, 1);
    assert_eq!(output(&v), json!({"name":"Ada","role":"user"}));
}

// dirty: trim overwrite
#[test]
fn overwrite_trim_sets_dirty() {
    let compiled = plan(&json!([{"k":"string","checks":[{"c":"overwrite","op":"trim"}]}]));
    let v = validate(&compiled, br#""  hi  ""#);
    assert_eq!(v.status, 1);
    assert_eq!(output(&v), json!("hi"));
}

// strict mode: unrecognized_keys
#[test]
fn object_strict_unrecognized_keys() {
    let compiled = plan(&json!([
        {"k":"object","keys":["name"],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"string","checks":[]}
    ]));
    let v = validate(&compiled, br#"{"name":"Ada","extra":1}"#);
    assert_issue(
        &v,
        &json!({"code":"unrecognized_keys","keys":["extra"],"path":[]}),
    );
}

// passthrough retains unknowns (dirty) in output
#[test]
fn object_passthrough_retains_unknown() {
    let compiled = plan(&json!([
        {"k":"object","keys":["name"],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"string","checks":[]}
    ]));
    let v = validate(&compiled, br#"{"name":"Ada","extra":1}"#);
    assert_eq!(v.status, 1);
    let out = output(&v);
    assert_eq!(out["name"], json!("Ada"));
    assert_eq!(out["extra"], json!(1));
}

// A `__proto__` shape key leaves the plan byte-path ineligible: JS resolves the
// key through `Object.prototype` when the input omits it, which the scanner
// cannot see, so the TS walk owns the schema. Mirrors `PROTO_KEYS` in
// packages/zodrs/src/core/plan.ts.
#[test]
fn proto_key_is_ordinary_data() {
    let compiled = plan(&json!([
        {"k":"object","keys":["__proto__"],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"number","checks":[]}
    ]));
    assert!(!compiled.json_eligible);
    let v = validate(&compiled, br#"{"__proto__":1}"#);
    assert_eq!(v.status, 3, "defers to the TS path: {v:?}");
}

// ------------------------------------------------------------------------
// Arrays and tuples
// ------------------------------------------------------------------------

#[rstest]
// valid array of ints
#[case(
    json!([{"k":"array","element":1,"checks":[]},{"k":"number","checks":[{"c":"number_format","v":"int32"}]}]),
    json!([1,2,3]),
    0
)]
// array min length ok
#[case(
    json!([{"k":"array","element":1,"checks":[{"c":"min_length","v":2}]},{"k":"number","checks":[]}]),
    json!([1,2]),
    0
)]
// valid tuple
#[case(
    json!([{"k":"tuple","items":[1,2],"rest":null},{"k":"string","checks":[]},{"k":"number","checks":[]}]),
    json!(["a",1]),
    0
)]
fn containers_valid(#[case] p: Json, #[case] input: Json, #[case] status: u8) {
    let compiled = plan(&p);
    let bytes = serde_json::to_vec(&input).unwrap();
    assert_eq!(validate(&compiled, &bytes).status, status);
}

#[rstest]
// array element invalid: index in path
#[case(
    json!([{"k":"array","element":1,"checks":[]},{"k":"number","checks":[{"c":"number_format","v":"int32"}]}]),
    json!([1,1.5,3]),
    json!({"code":"invalid_type","expected":"int","format":"int32","path":[1]})
)]
// array min length fail
#[case(
    json!([{"k":"array","element":1,"checks":[{"c":"min_length","v":3}]},{"k":"number","checks":[]}]),
    json!([1]),
    json!({"code":"too_small","origin":"array","minimum":3,"inclusive":true,"path":[]})
)]
// tuple element invalid: index in path
#[case(
    json!([{"k":"tuple","items":[1,2],"rest":null},{"k":"string","checks":[]},{"k":"number","checks":[]}]),
    json!([1,5]),
    json!({"code":"invalid_type","expected":"string","path":[0]})
)]
fn containers_invalid(#[case] p: Json, #[case] input: Json, #[case] expected: Json) {
    let compiled = plan(&p);
    let bytes = serde_json::to_vec(&input).unwrap();
    let verdict = validate(&compiled, &bytes);
    assert_issue(&verdict, &expected);
}

// ------------------------------------------------------------------------
// Wrappers, union, discriminated union, record, lazy cycle.
// ------------------------------------------------------------------------

#[test]
fn nullable_and_optional() {
    let compiled = plan(&json!([
        {"k":"nullable","inner":1},
        {"k":"string","checks":[]}
    ]));
    assert_eq!(validate(&compiled, b"null").status, 0);
    assert_eq!(validate(&compiled, br#""x""#).status, 0);
    assert_eq!(validate(&compiled, b"5").status, 2);
}

#[test]
fn union_first_match() {
    let compiled = plan(&json!([
        {"k":"union","options":[1,2]},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    assert_eq!(validate(&compiled, br#""x""#).status, 0);
    assert_eq!(validate(&compiled, b"5").status, 0);
    let v = validate(&compiled, b"true");
    assert_eq!(v.status, 2);
    assert_eq!(issues(&v.payload)[0]["code"], json!("invalid_union"));
}

#[test]
fn discriminated_union_dispatches() {
    let compiled = plan(&json!([
        {"k":"discunion","key":"type","map":[["a",1],["b",2]]},
        {"k":"object","keys":["type","x"],"values":[3,4],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"object","keys":["type","y"],"values":[5,6],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"literal","values":["a"]},
        {"k":"string","checks":[]},
        {"k":"literal","values":["b"]},
        {"k":"number","checks":[]}
    ]));
    assert_eq!(validate(&compiled, br#"{"type":"b","y":1}"#).status, 0,);
    // dispatch must select the "b" branch; a wrong dispatch would reject the shape.
    let bad = validate(&compiled, br#"{"type":"b","y":"nope"}"#);
    assert_eq!(bad.status, 2);
    assert_eq!(issues(&bad.payload)[0]["path"], json!(["y"]));
}

#[test]
fn record_validates_values() {
    let compiled = plan(&json!([
        {"k":"record","key":1,"value":2},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    assert_eq!(validate(&compiled, br#"{"a":1,"b":2}"#).status, 0);
    let v = validate(&compiled, br#"{"a":"x"}"#);
    assert_eq!(v.status, 2);
    assert_eq!(issues(&v.payload)[0]["path"], json!(["a"]));
}

#[test]
fn lazy_cycle_validates_nested() {
    // node0: lazy(1); node1: optional(2); node2: object{child:0}
    let compiled = plan(&json!([
        {"k":"lazy","inner":1},
        {"k":"optional","inner":2},
        {"k":"object","keys":["child"],"values":[0],"optional":[false],"mode":"strip","catchall":null}
    ]));
    // This plan is not actually self-consistent (child:0 -> lazy(1) -> optional(2)),
    // but it exercises the back-edge traversal without panic.
    let v = validate(&compiled, br#"{"child":{"child":1}}"#);
    assert!(matches!(v.status, 0 | 2), "{v:?}");
}

// ------------------------------------------------------------------------
// JSON eligibility
// ------------------------------------------------------------------------

#[test]
fn host_node_poisons_eligibility() {
    let compiled = plan(&json!([
        {"k":"object","keys":["x"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"host","inner":null,"fn":0}
    ]));
    assert!(!compiled.json_eligible);
    let v = validate(&compiled, br#"{"x":1}"#);
    assert_eq!(v.status, 3);
}

#[test]
fn unparseable_input_falls_back() {
    let v = validate(&user_plan(), b"{ not json ");
    assert_eq!(v.status, 3);
}

// ------------------------------------------------------------------------
// Differential-fuzz regression suite (one test per divergence class).
// ------------------------------------------------------------------------

// K2: duplicate keys resolve last-wins (ECMA-262 JSON.parse), not first-wins.
#[test]
fn k2_duplicate_keys_last_wins() {
    // z.string().min(3) at key "name"; duplicate name -> last value "Ada" wins.
    let compiled = plan(&json!([
        {"k":"object","keys":["name","age"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[{"c":"min_length","v":3}]},
        {"k":"number","checks":[]}
    ]));
    // First value "A" fails min(3); last value "Ada" passes. Must succeed.
    let v = validate(&compiled, br#"{"name":"A","name":"Ada","age":36}"#);
    assert_eq!(v.status, 1, "collapsed dup keys rewrite the input: {v:?}");
    assert_eq!(output(&v), json!({"name":"Ada","age":36}));

    // Last value fails -> the error is about "A", not the earlier "Ada".
    let bad = validate(&compiled, br#"{"name":"Ada","name":"A","age":36}"#);
    assert_issue(
        &bad,
        &json!({"code":"too_small","origin":"string","minimum":3,"inclusive":true,"path":["name"]}),
    );
}

// K4: .catch() fires on failure and substitutes the fallback value in output.
#[test]
fn k4_catch_fires_on_failure() {
    // root: catch(string, "dflt")
    let compiled = plan(&json!([
        {"k":"catch","inner":1,"value":"dflt"},
        {"k":"string","checks":[]}
    ]));
    let v = validate(&compiled, b"1");
    assert_eq!(v.status, 1, "catch rewrites the input: {v:?}");
    assert_eq!(output(&v), json!("dflt"));

    // Nested: strictObject({}).catch({}) at key b; [1,2] fails -> b becomes {}.
    let nested = plan(&json!([
        {"k":"object","keys":["b"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"catch","inner":2,"value":{}},
        {"k":"object","keys":[],"values":[],"optional":[],"mode":"strict","catchall":null}
    ]));
    let nv = validate(&nested, br#"{"b":[1,2]}"#);
    assert_eq!(nv.status, 1);
    assert_eq!(output(&nv), json!({"b":{}}));

    // catch on success passes the inner value through unchanged.
    let ok = validate(&compiled, br#""hello""#);
    assert_eq!(ok.status, 0, "clean success: {ok:?}");
}

// K5: regex issue carries the JS `pattern` source and `origin: "string"`,
// matching zod v4's `$ZodIssueInvalidStringFormat` (verified against 4.4.3).
#[test]
fn k5_regex_issue_has_pattern() {
    let compiled = plan(&json!([
        {"k":"string","checks":[{"c":"regex","src":"^[a-z]+$","flags":""}]}
    ]));
    let v = validate(&compiled, br#""ABC""#);
    assert_issue(
        &v,
        &json!({"code":"invalid_format","origin":"string","format":"regex","pattern":"/^[a-z]+$/","path":[]}),
    );
}

// K6: strict objects skip __proto__ in the unrecognized-keys scan.
#[test]
fn k6_strict_skips_proto() {
    let compiled = plan(&json!([
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"number","checks":[]}
    ]));
    // __proto__ present as unknown key: not flagged, dropped from output.
    let v = validate(&compiled, br#"{"a":1,"__proto__":2}"#);
    assert_eq!(v.status, 1, "proto dropped -> rewritten: {v:?}");
    assert_eq!(output(&v), json!({"a":1}));
}

// K7: no-match discriminated union emits the full discriminator issue.
#[test]
fn k7_discriminator_issue_shape() {
    let compiled = plan(&json!([
        {"k":"discunion","key":"kind","map":[["dog",1],["cat",2]]},
        {"k":"object","keys":["kind"],"values":[3],"optional":[false],"mode":"strip","catchall":null},
        {"k":"object","keys":["kind"],"values":[4],"optional":[false],"mode":"strip","catchall":null},
        {"k":"literal","values":["dog"]},
        {"k":"literal","values":["cat"]}
    ]));
    let v = validate(&compiled, br#"{"kind":"fish"}"#);
    assert_issue(
        &v,
        // Canonical zod emits no `note` on a discriminator miss.
        &json!({
            "code":"invalid_union",
            "errors":[],
            "note":"No matching discriminator",
            "discriminator":"kind",
            "options":["dog","cat"],
            "path":["kind"]
        }),
    );
}

// K8: missing keys report the node's own missing-input issue, not "unknown".
#[test]
fn k8_missing_key_expected_per_node() {
    // Missing object-typed key -> invalid_type expected "object".
    let obj = plan(&json!([
        {"k":"object","keys":["inner"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"object","keys":["x"],"values":[2],"optional":[false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]));
    assert_issue(
        &validate(&obj, b"{}"),
        &json!({"code":"invalid_type","expected":"object","path":["inner"]}),
    );

    // Missing enum key -> invalid_value with the values, not invalid_type.
    let en = plan(&json!([
        {"k":"object","keys":["role"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"enum","values":["admin","user"]}
    ]));
    assert_issue(
        &validate(&en, b"{}"),
        &json!({"code":"invalid_value","values":["admin","user"],"path":["role"]}),
    );
}

// K9: the empty string is an ordinary object key.
#[test]
fn k9_empty_string_key() {
    let compiled = plan(&json!([
        {"k":"object","keys":[""],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"number","checks":[{"c":"number_format","v":"int32"}]}
    ]));
    // Present "" value validates cleanly (no spurious unrecognized_keys / missing).
    assert_eq!(validate(&compiled, br#"{"":36}"#).status, 0);
    // "" enum violation at the "" path is reported, not silently accepted.
    let en = plan(&json!([
        {"k":"object","keys":[""],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"enum","values":["a","b"]}
    ]));
    assert_issue(
        &validate(&en, br#"{"":"z"}"#),
        &json!({"code":"invalid_value","values":["a","b"],"path":[""]}),
    );
}

// K11: record rejects a non-object root as expected:"record".
#[test]
fn k11_record_root_type() {
    let compiled = plan(&json!([
        {"k":"record","key":1,"value":2},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    assert_issue(
        &validate(&compiled, b"[1,2,3]"),
        &json!({"code":"invalid_type","expected":"record","path":[]}),
    );
}

// K13: array element issues precede array length checks.
#[test]
fn k13_array_issue_order() {
    // array(boolean).min(2); input [[1]] -> element(0) invalid, then too_small.
    let compiled = plan(&json!([
        {"k":"array","element":1,"checks":[{"c":"min_length","v":2}]},
        {"k":"boolean"}
    ]));
    let v = validate(&compiled, b"[[1]]");
    assert_eq!(v.status, 2);
    let got = issues(&v.payload);
    assert_eq!(got.len(), 2, "{got:?}");
    assert_eq!(got[0]["code"], json!("invalid_type"));
    assert_eq!(got[0]["expected"], json!("boolean"));
    assert_eq!(got[0]["path"], json!([0]));
    assert_eq!(got[1]["code"], json!("too_small"));
    assert_eq!(got[1]["origin"], json!("array"));
    assert_eq!(got[1]["path"], json!([]));
}

// ------------------------------------------------------------------------
// Regression: records skip `__proto__` keys entirely (never validated,
// never retained) — canonical zod builds record output with plain-object
// assignment, where `__proto__` would target the prototype.
// ------------------------------------------------------------------------

#[test]
fn record_proto_key_skipped_in_check_and_output() {
    let rec = plan(&json!([
        {"k":"record","key":1,"value":2},
        {"k":"string","checks":[]},
        {"k":"boolean","checks":[]}
    ]));
    // The `__proto__` value (a string) would fail the boolean schema if
    // validated; canonical skips it, so the parse succeeds and the output
    // drops the key.
    let v = validate(&rec, br#"{"__proto__":"x","a":true}"#);
    assert_eq!(output(&v), json!({"a": true}));

    // A record whose only key is `__proto__` validates to an empty object.
    let v = validate(&rec, br#"{"__proto__":null}"#);
    assert_eq!(output(&v), json!({}));
}

#[test]
fn object_unknown_proto_dropped_in_all_modes() {
    for mode in ["strip", "passthrough", "strict"] {
        let obj = plan(&json!([
            {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":mode,"catchall":null},
            {"k":"string","checks":[]}
        ]));
        let v = validate(&obj, br#"{"a":"x","__proto__":1}"#);
        assert_eq!(output(&v), json!({"a": "x"}), "mode {mode}");
    }
    // Catchall does not validate or retain __proto__ either.
    let ca = plan(&json!([
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":2},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&ca, br#"{"a":"x","__proto__":"not-a-number"}"#);
    assert_eq!(output(&v), json!({"a": "x"}));
}

#[test]
fn object_shape_key_named_proto_defers_to_the_ts_path() {
    let obj = plan(&json!([
        {"k":"object","keys":["__proto__"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"string","checks":[]}
    ]));
    // The scanner cannot tell an absent `__proto__` from the inherited one the
    // TS walk reads, so the whole plan stays off the byte path either way.
    assert!(!obj.json_eligible);
    assert_eq!(validate(&obj, br#"{"__proto__":"x"}"#).status, 3);
    assert_eq!(validate(&obj, br#"{"__proto__":1}"#).status, 3);
}

// ------------------------------------------------------------------------
// Regression: duplicate keys collapse last-wins but keep the first
// position (ECMA-262 JSON.parse semantics).
// ------------------------------------------------------------------------

#[test]
fn duplicate_key_keeps_first_position_with_last_value() {
    let obj = plan(&json!([
        {"k":"object","keys":["b","a"],"values":[1,1],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&obj, br#"{"b":1,"a":2,"b":3}"#);
    assert_eq!(v.status, 1, "duplicate collapse rewrites: {v:?}");
    let payload = v.payload.as_deref().unwrap();
    assert_eq!(payload, r#"{"b":3,"a":2}"#);
}

// ------------------------------------------------------------------------
// Regression: canonical tuple length semantics.
// ------------------------------------------------------------------------

#[test]
fn tuple_short_input_reports_only_too_small() {
    let tup = plan(&json!([
        {"k":"tuple","items":[1,2,3],"rest":null},
        {"k":"string","checks":[{"c":"min_length","v":3}]},
        {"k":"number","checks":[]},
        {"k":"boolean","checks":[]}
    ]));
    // One present (invalid) item, but a short input skips item validation.
    assert_issue(
        &validate(&tup, br#"["a"]"#),
        &json!({"code":"too_small","origin":"array","minimum":3,"inclusive":true,"path":[]}),
    );
}

#[test]
fn tuple_long_input_reports_too_big_and_validates_items() {
    let tup = plan(&json!([
        {"k":"tuple","items":[1],"rest":null},
        {"k":"string","checks":[{"c":"min_length","v":3}]}
    ]));
    let v = validate(&tup, br#"["a",999]"#);
    assert_eq!(v.status, 2);
    let got = issues(&v.payload);
    assert_eq!(
        Json::Array(got),
        json!([
            {"code":"too_big","origin":"array","maximum":1,"inclusive":true,"path":[]},
            {"code":"too_small","origin":"string","minimum":3,"inclusive":true,"path":[0]}
        ])
    );
}

#[test]
fn tuple_optional_tail_changes_length_floor_and_output() {
    let tup = plan(&json!([
        {"k":"tuple","items":[1,2],"rest":null},
        {"k":"string","checks":[]},
        {"k":"optional","inner":3},
        {"k":"number","checks":[]}
    ]));
    // Trailing optional item: a one-element input is valid, and the absent
    // optional slot drops out of the output.
    let v = validate(&tup, br#"["a"]"#);
    assert_eq!(v.status, 0, "no rewrite needed: {v:?}");

    // A leading optional does not lower the floor.
    let lead = plan(&json!([
        {"k":"tuple","items":[1,2],"rest":null},
        {"k":"optional","inner":3},
        {"k":"number","checks":[]},
        {"k":"string","checks":[]}
    ]));
    assert_issue(
        &validate(&lead, br"[]"),
        &json!({"code":"too_small","origin":"array","minimum":2,"inclusive":true,"path":[]}),
    );
}

#[test]
fn tuple_absent_default_and_catch_fill_slots() {
    let tup = plan(&json!([
        {"k":"tuple","items":[1,2],"rest":null},
        {"k":"string","checks":[]},
        {"k":"default","inner":3,"value":7,"dynamic":false},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&tup, br#"["a"]"#);
    assert_eq!(output(&v), json!(["a", 7]));

    let cat = plan(&json!([
        {"k":"tuple","items":[1,2],"rest":null},
        {"k":"string","checks":[]},
        {"k":"catch","inner":3,"value":9,"dynamic":false},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&cat, br#"["a"]"#);
    assert_eq!(output(&v), json!(["a", 9]));
}

#[test]
fn tuple_with_rest_validates_absent_items_as_undefined() {
    let tup = plan(&json!([
        {"k":"tuple","items":[1],"rest":2},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    assert_issue(
        &validate(&tup, br"[]"),
        &json!({"code":"invalid_type","expected":"string","path":[0]}),
    );
}

#[test]
fn tuple_absent_nullable_of_optional_is_swallowed() {
    // z.nullable(z.string().optional()) delegates optin to its inner type,
    // so the trailing slot accepts absence and drops out.
    let tup = plan(&json!([
        {"k":"tuple","items":[1,2],"rest":null},
        {"k":"string","checks":[]},
        {"k":"nullable","inner":3},
        {"k":"optional","inner":4},
        {"k":"string","checks":[]}
    ]));
    let v = validate(&tup, br#"["a"]"#);
    assert_eq!(v.status, 0, "nullable(optional) accepts absence: {v:?}");
}

// ------------------------------------------------------------------------
// Regression: object issues are emitted in schema key order, not input
// order (canonical zod iterates the shape).
// ------------------------------------------------------------------------

#[test]
fn object_issues_follow_schema_key_order() {
    let obj = plan(&json!([
        {"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&obj, br#"{"b":"x","a":1}"#);
    assert_eq!(v.status, 2);
    let got = issues(&v.payload);
    assert_eq!(
        Json::Array(got),
        json!([
            {"code":"invalid_type","expected":"string","path":["a"]},
            {"code":"invalid_type","expected":"number","path":["b"]}
        ]),
        "schema order a-then-b even though the input lists b first"
    );

    // Missing and present-but-invalid keys interleave in schema order.
    let v = validate(&obj, br#"{"b":"x"}"#);
    let got = issues(&v.payload);
    assert_eq!(
        Json::Array(got),
        json!([
            {"code":"invalid_type","expected":"string","path":["a"]},
            {"code":"invalid_type","expected":"number","path":["b"]}
        ])
    );
}

// ------------------------------------------------------------------------
// Regression: number serialization edge cases.
// ------------------------------------------------------------------------

#[test]
fn negative_zero_rewrite_defers_to_js_path() {
    // A dirty parse whose input carries -0 cannot rewrite it faithfully
    // (sonic-rs normalizes -0 to 0.0), so the verdict defers (status 3).
    let obj = plan(&json!([
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&obj, br#"{"a":-0,"extra":1}"#);
    assert_eq!(v.status, 3, "-0 with a dirty rewrite defers: {v:?}");

    // Clean parses leave the bytes to JSON.parse, which keeps -0.
    let v = validate(&obj, br#"{"a":-0}"#);
    assert_eq!(v.status, 0, "clean parse keeps the bytes: {v:?}");

    // A "-0" inside a string is not a number token and must not defer.
    let obj2 = plan(&json!([
        {"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},
        {"k":"string","checks":[]},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&obj2, br#"{"a":"-0","b":1,"extra":2}"#);
    assert_eq!(output(&v), json!({"a": "-0", "b": 1}));
}

#[test]
fn coerce_number_js_semantics() {
    let num = plan(&json!([{"k":"number","coerce":true,"checks":[]}]));
    // Overflowing strings coerce to Infinity: valid, but JSON cannot write
    // it back, so the verdict defers to the JS path.
    assert_eq!(validate(&num, br#""1e400""#).status, 3);
    assert_eq!(validate(&num, br#""Infinity""#).status, 3);
    // NaN-producing strings fail as invalid_type.
    assert_issue(
        &validate(&num, br#""nan""#),
        &json!({"code":"invalid_type","expected":"number","path":[]}),
    );
    assert_issue(
        &validate(&num, br#""inf""#),
        &json!({"code":"invalid_type","expected":"number","path":[]}),
    );
    // Radix prefixes and null follow JS Number().
    assert_eq!(output(&validate(&num, br#""0x1F""#)), json!(31));
    assert_eq!(output(&validate(&num, br"null")), json!(0));
}

#[test]
fn coerce_string_uses_js_number_formatting() {
    let s = plan(&json!([{"k":"string","coerce":true,"checks":[]}]));
    assert_eq!(output(&validate(&s, br"2e4")), json!("20000"));
    assert_eq!(output(&validate(&s, br"1e21")), json!("1e+21"));
    assert_eq!(output(&validate(&s, br"1.5e-7")), json!("1.5e-7"));
    assert_eq!(output(&validate(&s, br"0.000001")), json!("0.000001"));
    assert_eq!(
        output(&validate(&s, br"0.30000000000000004")),
        json!("0.30000000000000004")
    );
}
// ------------------------------------------------------------------------
// Regression: union flattening — exactly one option type-matches.
// union[string.min(3), number] on "ab" → string type-matched (too_small),
// number type-mismatched (invalid_type). Canonical: surface too_small directly.
// ------------------------------------------------------------------------

#[test]
fn union_flatten_single_type_match() {
    let p = plan(&json!([
        {"k":"union","options":[1,2]},
        {"k":"string","checks":[{"c":"min_length","v":3}]},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&p, br#""ab""#);
    // Branch 1 (string min 3): too_small from checkPayloadIssues → continue:true → nonaborted.
    // Branch 2 (number): invalid_type from issue() → continue:undefined → NOT nonaborted.
    // nonaborted.length == 1 → flatten branch 1's too_small directly.
    assert_eq!(v.status, 2, "expected invalid: {v:?}");
    let iss = issues(&v.payload);
    assert_eq!(iss.len(), 1, "expected 1 flattened issue, got {iss:?}");
    assert_eq!(iss[0]["code"], "too_small", "got: {iss:?}");
    assert_eq!(iss[0]["origin"], "string");
    assert_eq!(iss[0]["minimum"], 3);
    assert_eq!(iss[0]["inclusive"], true);
    assert_eq!(iss[0]["path"], json!([]));
}

// ------------------------------------------------------------------------
// Regression: union sub-issue paths are RELATIVE to the option.
// union[object{name:string}, object{name:number}] on {"name":true}
// → both branches fail with relative path ["name"], wrapper carries [].
// ------------------------------------------------------------------------

#[test]
fn union_sub_issue_relative_paths() {
    let p = plan(&json!([
        {"k":"union","options":[1,3]},
        {"k":"object","keys":["name"],"values":[2],"optional":[false],"mode":"strip","catchall":null},
        {"k":"string","checks":[]},
        {"k":"object","keys":["name"],"values":[4],"optional":[false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]));
    let v = validate(&p, br#"{"name":true}"#);
    assert_eq!(v.status, 2, "expected invalid: {v:?}");
    let iss = issues(&v.payload);
    // Both branches type-mismatch (object vs boolean input) → no flattening,
    // invalid_union wrapper with relative sub-issue paths.
    assert_eq!(iss.len(), 1, "expected 1 issue, got {iss:?}");
    assert_eq!(iss[0]["code"], "invalid_union");
    assert_eq!(iss[0]["path"], json!([]));
    // Sub-issues should have relative paths ["name"], not ["name"] prefixed with union path.
    let errors = iss[0]["errors"].as_array().unwrap();
    for branch in errors {
        for sub in branch.as_array().unwrap() {
            assert_eq!(
                sub["path"],
                json!(["name"]),
                "sub-issue path should be relative: {sub:?}"
            );
        }
    }
}

// ------------------------------------------------------------------------
// Regression: invalid_format issue includes `pattern` field and correct
// key order (origin, format, pattern, path).
// ------------------------------------------------------------------------

#[test]
fn format_issue_includes_pattern_and_key_order() {
    let p = plan(&json!([
        {"k":"string","checks":[{"c":"format","v":"uuid"}]}
    ]));
    let v = validate(&p, br#""not-a-uuid""#);
    assert_eq!(v.status, 2, "expected invalid: {v:?}");
    let iss = issues(&v.payload);
    assert_eq!(iss.len(), 1);
    let obj = iss[0].as_object().unwrap();
    // Key order: code, origin, format, pattern, path
    let keys: Vec<&str> = obj.keys().map(std::string::String::as_str).collect();
    assert_eq!(
        keys,
        vec!["code", "origin", "format", "pattern", "path"],
        "key order: {keys:?}"
    );
    assert_eq!(obj["code"], "invalid_format");
    assert_eq!(obj["origin"], "string");
    assert_eq!(obj["format"], "uuid");
    assert!(obj["pattern"].is_string(), "pattern should be present");
}

// ------------------------------------------------------------------------
// Regression: discunion no-match issue includes `note` field with correct
// key order (code, errors, note, discriminator, options, path).
// ------------------------------------------------------------------------

#[test]
fn discunion_note_field_and_key_order() {
    let p = plan(&json!([
        {"k":"discunion","key":"kind","map":[["dog",1],["cat",2]]},
        {"k":"object","keys":["kind"],"values":[3],"optional":[false],"mode":"strip","catchall":null},
        {"k":"object","keys":["kind"],"values":[4],"optional":[false],"mode":"strip","catchall":null},
        {"k":"literal","values":["dog"]},
        {"k":"literal","values":["cat"]}
    ]));
    let v = validate(&p, br#"{"kind":"fish"}"#);
    assert_eq!(v.status, 2, "expected invalid: {v:?}");
    let iss = issues(&v.payload);
    assert_eq!(iss.len(), 1);
    let obj = iss[0].as_object().unwrap();
    // Key order: code, errors, note, discriminator, options, path
    let keys: Vec<&str> = obj.keys().map(std::string::String::as_str).collect();
    assert_eq!(
        keys,
        vec!["code", "errors", "note", "discriminator", "options", "path"],
        "key order: {keys:?}"
    );
    assert_eq!(obj["note"], "No matching discriminator");
}
