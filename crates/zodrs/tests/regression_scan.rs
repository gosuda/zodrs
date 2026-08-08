//! Regression guards for bugs found by the differential fuzz against the
//! scan fast-path and the two-pass union walk. Each test pins one historical
//! divergence between `safeParseJson` (native) and `safeParse` (JS).

#![allow(clippy::unwrap_used)]

use zodrs::{compile, validate};

/// `1e400` overflows f64. The scan's number token must not accept it as a
/// finite value (it used to yield `inf`, validating a positive number where
/// zod rejects `Infinity`); sonic-rs also rejects the token at parse time, so
/// the verdict defers to the JS path, which reports `invalid_type`.
#[test]
fn number_overflow_defers() {
    let plan = compile(r#"[{"k":"number","checks":[]}]"#).unwrap();
    let v = validate(&plan, b"1e400");
    assert_eq!(v.status, 3, "overflow must defer to the JS path: {v:?}");
}

/// A string token whose escape introducer is the final input byte used to
/// panic the scanner (`off = at + 2` past the slice end). Must defer cleanly:
/// the DOM parse then fails and the verdict falls back to the JS path.
#[test]
fn truncated_escape_no_panic() {
    let plan = compile(r#"[{"k":"array","element":1,"checks":[]},{"k":"any"}]"#).unwrap();
    let v = validate(&plan, b"[\"x\\");
    assert_eq!(v.status, 3, "truncated input must fall back: {v:?}");
}

/// Missing object key with a default: the walk must mark dirty so the rewrite
/// materializes the default (status 1), not return the input verbatim.
#[test]
fn missing_default_rewrites() {
    let plan = compile(
        r#"[{"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"default","inner":2,"value":5,"dynamic":false},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, b"{}");
    assert_eq!(v.status, 1);
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":5}"#));
}

/// Strip mode drops unknown keys on rewrite (status 1), never keeps them.
#[test]
fn strip_unknown_key_rewrites() {
    let plan = compile(
        r#"[{"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":1,"x":2}"#);
    assert_eq!(v.status, 1);
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":1}"#));
}

/// A union option whose inner checks are swallowed by `catch` is a SUCCESS:
/// the catch restores the fail counter, so the enclosing union's dry run must
/// read the option as clean and keep the catch/default rewrite dirty flag.
/// Regression: the catch left `fail_count` bumped, the union took the
/// all-failed path, and the verdict returned the input verbatim (status 0)
/// with defaults and catch values lost.
#[test]
fn catch_inside_union_option_is_clean() {
    let plan = compile(
        r#"[
          {"k":"object","keys":["value"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
          {"k":"tuple","items":[2],"rest":null},
          {"k":"optional","inner":3},
          {"k":"union","options":[4,8]},
          {"k":"record","key":5,"value":6},
          {"k":"string","checks":[]},
          {"k":"optional","inner":7},
          {"k":"object","keys":["id","k1"],"values":[9,11],"optional":[false,false],"mode":"strip","catchall":null},
          {"k":"boolean"},
          {"k":"catch","inner":8,"value":true,"dynamic":false},
          {"k":"boolean"},
          {"k":"default","inner":12,"value":5,"dynamic":false},
          {"k":"number","checks":[]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"value":[{"k1":{"id":true},"k2":{"id":1}}]}"#);
    assert_eq!(v.status, 1, "catch/default rewrite must apply: {v:?}");
    assert_eq!(
        v.payload.as_deref(),
        Some(r#"{"value":[{"k1":{"id":true,"k1":5},"k2":{"id":true,"k1":5}}]}"#)
    );
}

/// A nested union that SUCCEEDS must not leak the fail-counter bumps of its
/// own abandoned sub-options into the enclosing union's dry run. Regression:
/// an enum option containing "" matched the input "", but the enclosing union
/// read the option as failed and emitted `invalid_union` with an empty branch
/// (`errors: [[ends_with issue], []]`).
#[test]
fn nested_union_success_leaves_no_fail_trace() {
    // union([string endsWith "yz", union([object strict {}, enum ["red","","a"]])])
    let plan = compile(
        r#"[
          {"k":"union","options":[1,3]},
          {"k":"string","checks":[{"c":"ends_with","v":"yz"}]},
          {"k":"string","checks":[]},
          {"k":"union","options":[4,5]},
          {"k":"object","keys":[],"values":[],"optional":[],"mode":"strict","catchall":null},
          {"k":"enum","values":["red","","a"]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, b"\"\"");
    assert_eq!(v.status, 0, "empty string matches the enum option: {v:?}");
}

/// End-to-end pin of the fuzz failure at seed 24301 case 2357: a strip-mode
/// object nested behind two union levels and a passthrough root must rewrite
/// (status 1) with unknown keys dropped at every level. The plan and input
/// are the exact artifacts the fuzz generated, compiled by the TS builder.
#[test]
fn fuzz_seed24301_case2357() {
    let plan = compile(include_str!("testdata/sig1-plan.json")).unwrap();
    assert!(plan.json_eligible);
    let input = include_str!("testdata/sig1-input.json").trim().as_bytes();
    let v = validate(&plan, input);
    assert_eq!(v.status, 1, "nested strip must rewrite: {v:?}");
    let out = v.payload.unwrap();
    assert!(!out.contains("extra"), "unknown key retained: {out}");
    assert!(!out.contains("$weird"), "unknown key retained: {out}");
    assert!(out.contains(r#""tag":450"#), "known key dropped: {out}");
}
