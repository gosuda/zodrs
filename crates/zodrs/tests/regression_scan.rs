//! Regression guards for bugs found by the differential fuzz against the
//! scan fast-path and the two-pass union walk. Each test pins one historical
//! divergence between `safeParseJson` (native) and `safeParse` (JS).

#![allow(clippy::unwrap_used)]

use std::iter;
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
        r#"[{"k":"object","keys":["a"],"values":[1],"optional":[true],"mode":"strip","catchall":null},{"k":"default","inner":2,"value":5,"dynamic":false},{"k":"number","checks":[]}]"#,
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
          {"k":"object","keys":["id","k1"],"values":[9,11],"optional":[false,true],"mode":"strip","catchall":null},
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

#[test]
fn repeated_union_node_reuses_the_decision_for_each_value() {
    let plan = compile(
        r#"[
          {"k":"object","keys":["a","b"],"values":[1,1],"optional":[false,false],"mode":"strip","catchall":null},
          {"k":"union","options":[2,3]},
          {"k":"string","checks":[{"c":"overwrite","op":"trim"}]},
          {"k":"number","checks":[]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":" x ","b":1}"#);
    assert_eq!(v.status, 1, "trim must force a rewrite: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":"x","b":1}"#));
}

#[test]
fn repeated_catch_node_keeps_inner_and_fallback_decisions_separate() {
    let plan = compile(
        r#"[
          {"k":"object","keys":["a","b"],"values":[1,1],"optional":[false,false],"mode":"strip","catchall":null},
          {"k":"catch","inner":2,"value":"caught","dynamic":false},
          {"k":"string","checks":[]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":"ok","b":1}"#);
    assert_eq!(v.status, 1, "catch must force a rewrite: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":"ok","b":"caught"}"#));
}

#[test]
fn dirty_discriminated_union_reuses_its_selected_branch() {
    let plan = compile(
        r#"[
          {"k":"discunion","key":"type","map":[["a",1],["b",5]]},
          {"k":"object","keys":["type","value"],"values":[2,3],"optional":[false,false],"mode":"strip","catchall":null},
          {"k":"literal","values":["a"]},
          {"k":"string","checks":[{"c":"overwrite","op":"trim"}]},
          {"k":"string","checks":[]},
          {"k":"object","keys":["type","value"],"values":[6,7],"optional":[false,false],"mode":"strip","catchall":null},
          {"k":"literal","values":["b"]},
          {"k":"number","checks":[]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"type":"a","value":" x "}"#);
    assert_eq!(v.status, 1, "trim must force a rewrite: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"type":"a","value":"x"}"#));
}

#[test]
fn prefault_temporary_decisions_do_not_replace_present_value_decisions() {
    let plan = compile(
        r#"[
          {"k":"object","keys":["missing","present"],"values":[1,2],"optional":[true,false],"mode":"strip","catchall":null},
          {"k":"prefault","inner":2,"value":" x ","dynamic":false},
          {"k":"union","options":[3,4]},
          {"k":"string","checks":[{"c":"overwrite","op":"trim"}]},
          {"k":"number","checks":[]}
        ]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"present":1}"#);
    assert_eq!(v.status, 1, "prefault must materialize missing: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"missing":"x","present":1}"#));
}
// ------------------------------------------------------------------------
// Depth preflight (H6).
// ------------------------------------------------------------------------

/// Plan JSON for a `depth`-level nested array terminating in a trim string.
fn nested_array_plan(depth: usize) -> String {
    assert!(depth > 0, "depth must be positive");
    let mut nodes = Vec::with_capacity(depth + 1);
    for i in 0..depth {
        nodes.push(format!(
            r#"{{"k":"array","element":{},"checks":[]}}"#,
            i + 1
        ));
    }
    nodes.push(r#"{"k":"string","checks":[{"c":"overwrite","op":"trim"}]}"#.into());
    format!("[{}]", nodes.join(","))
}

fn nested_array_input(depth: usize, inner: &str) -> String {
    format!(
        "{}{}{}",
        iter::repeat_n('[', depth).collect::<String>(),
        inner,
        iter::repeat_n(']', depth).collect::<String>()
    )
}

/// Hostile nesting beyond the DOM budget returns status 3 without attempting
/// the recursive sonic/validator path.
#[test]
fn deep_nesting_20k_returns_status_3() {
    let plan = compile(r#"[{"k":"any"}]"#).unwrap();
    let input = nested_array_input(20_000, "1");
    let v = validate(&plan, input.as_bytes());
    assert_eq!(v.status, 3, "20k nested input must fall back: {v:?}");
    assert!(v.payload.is_none());
}

/// The measured DOM cap still permits a real recursive validation and rewrite.
#[test]
fn deep_nesting_at_dom_cap_gets_verdict() {
    let depth = 64;
    let plan = compile(&nested_array_plan(depth)).unwrap();
    let input = nested_array_input(depth, "\"  hello  \"");
    let v = validate(&plan, input.as_bytes());
    assert_eq!(
        v.status, 1,
        "depth-64 input must survive the DOM walk: {v:?}"
    );
    let expected = format!(
        "{}{}{}",
        iter::repeat_n('[', depth).collect::<String>(),
        "\"hello\"",
        iter::repeat_n(']', depth).collect::<String>()
    );
    assert_eq!(v.payload.as_deref(), Some(expected.as_str()));
}

/// One level beyond the cap falls back before the recursive DOM path.
#[test]
fn deep_nesting_above_dom_cap_falls_back() {
    let depth = 65;
    let plan = compile(&nested_array_plan(depth)).unwrap();
    let input = nested_array_input(depth, "\"  hello  \"");
    let v = validate(&plan, input.as_bytes());
    assert_eq!(v.status, 3, "depth-65 input must fall back: {v:?}");
}

/// Brackets, escaped quotes, and escaped backslashes inside strings do not
/// false-trigger the depth guard.
#[test]
fn preflight_ignores_brackets_and_escapes_in_strings() {
    let plan = compile(r#"[{"k":"string","checks":[{"c":"overwrite","op":"trim"}]}]"#).unwrap();
    // The string value contains literal brackets, an escaped quote, and an
    // escaped backslash. The scanner defers on escapes, so the preflight runs.
    let input = sonic_rs::to_vec(&"[ { ] } \" \\").unwrap();
    let v = validate(&plan, &input);
    assert_eq!(
        v.status, 0,
        "bracket-rich string must not false-trigger guard: {v:?}"
    );
}

/// Mismatched and unmatched closers are rejected before sonic-rs.
#[test]
fn preflight_rejects_mismatched_closer() {
    let plan = compile(r#"[{"k":"any"}]"#).unwrap();
    assert_eq!(validate(&plan, b"[}").status, 3);
    assert_eq!(validate(&plan, b"]").status, 3);
}

/// Canonical object keys in schema order validate clean (status 0).
#[test]
fn canonical_object_keys_status_0() {
    let plan = compile(
        r#"[{"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},{"k":"number","checks":[]},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":1,"b":2}"#);
    assert_eq!(v.status, 0, "in-order keys must be clean: {v:?}");
    assert!(v.payload.is_none());
}

/// Out-of-order keys require a canonical rewrite (status 1).
#[test]
fn out_of_order_object_keys_rewrite() {
    let plan = compile(
        r#"[{"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},{"k":"number","checks":[]},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"b":2,"a":1}"#);
    assert_eq!(v.status, 1, "out-of-order keys must rewrite: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":1,"b":2}"#));
}

/// Duplicate object keys collapse to the last value on rewrite (status 1).
#[test]
fn duplicate_object_key_last_wins() {
    let plan = compile(
        r#"[{"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":1,"a":2}"#);
    assert_eq!(
        v.status, 1,
        "duplicate keys must rewrite to last-wins: {v:?}"
    );
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":2}"#));
}

/// Strip mode drops an unknown key between known keys on rewrite (status 1).
#[test]
fn strip_unknown_key_between_known_rewrites() {
    let plan = compile(
        r#"[{"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"strip","catchall":null},{"k":"number","checks":[]},{"k":"number","checks":[]}]"#,
    )
    .unwrap();
    let v = validate(&plan, br#"{"a":1,"x":9,"b":2}"#);
    assert_eq!(v.status, 1, "unknown key must be stripped: {v:?}");
    assert_eq!(v.payload.as_deref(), Some(r#"{"a":1,"b":2}"#));
}
