//! Direct unit tests for the byte scanner.
//!
//! The regression suite in `regression_scan.rs` is end-to-end and cannot
//! distinguish `Scan::Clean` from `Scan::Defer` because both may yield a
//! status-0 verdict. The tests here call `scan::scan` directly to pin the
//! scanner's acceptance boundary.

#![allow(clippy::unwrap_used)]

use std::iter;

use zodrs::{compile, scan::Scan};

fn scan(plan_json: &str, input: &[u8]) -> Scan {
    let plan = compile(plan_json).unwrap();
    zodrs::scan::scan(&plan, input)
}

#[test]
fn clean_simple_object() {
    let plan = r#"[
        {"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"a":1,"b":2}"#), Scan::Clean);
}

#[test]
fn defer_out_of_order_keys() {
    let plan = r#"[
        {"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]},
        {"k":"number","checks":[]}
    ]"#;
    // Keys arrive in the wrong order; DOM walk must rewrite.
    assert_eq!(scan(plan, br#"{"b":2,"a":1}"#), Scan::Defer);
}

#[test]
fn defer_unknown_key_in_strip_mode() {
    let plan = r#"[
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"a":1,"b":2}"#), Scan::Defer);
}

#[test]
fn clean_emoji_min_length_2() {
    // "🎉" is one char, two UTF-16 code units, four UTF-8 bytes.
    let plan = r#"[{"k":"string","checks":[{"c":"min_length","v":2}]}]"#;
    assert_eq!(scan(plan, "\"🎉\"".as_bytes()), Scan::Clean);
}

#[test]
fn defer_emoji_max_length_1() {
    let plan = r#"[{"k":"string","checks":[{"c":"max_length","v":1}]}]"#;
    assert_eq!(scan(plan, "\"🎉\"".as_bytes()), Scan::Defer);
}

#[test]
fn clean_int32_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"int32"}]}]"#;
    assert_eq!(scan(plan, b"2147483647"), Scan::Clean);
}

#[test]
fn defer_int32_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"int32"}]}]"#;
    assert_eq!(scan(plan, b"2147483648"), Scan::Defer);
}

#[test]
fn clean_uint32_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"uint32"}]}]"#;
    assert_eq!(scan(plan, b"4294967295"), Scan::Clean);
}

#[test]
fn defer_uint32_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"uint32"}]}]"#;
    assert_eq!(scan(plan, b"4294967296"), Scan::Defer);
}

#[test]
fn clean_safeint_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"safeint"}]}]"#;
    assert_eq!(scan(plan, b"9007199254740991"), Scan::Clean);
}

#[test]
fn defer_safeint_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"safeint"}]}]"#;
    assert_eq!(scan(plan, b"9007199254740992"), Scan::Defer);
}

#[test]
fn clean_empty_string_key() {
    let plan = r#"[
        {"k":"object","keys":[""],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"":1}"#), Scan::Clean);
}

#[test]
fn clean_long_object_key() {
    // "verylongkey" is > 8 bytes; should hit the `long` vec path.
    let plan = r#"[
        {"k":"object","keys":["verylongkey"],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"verylongkey":1}"#), Scan::Clean);
}

#[test]
fn clean_eight_byte_key() {
    // 8 bytes is the upper boundary of the packed-word path (kb.len() <= 8).
    let plan = r#"[
        {"k":"object","keys":["abcdefgh"],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"abcdefgh":1}"#), Scan::Clean);
}

#[test]
fn clean_nine_byte_key() {
    // 9 bytes crosses into the `long` vec path (kb.len() > 8).
    let plan = r#"[
        {"k":"object","keys":["abcdefghi"],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"abcdefghi":1}"#), Scan::Clean);
}

#[test]
fn clean_eight_byte_keys_differ_in_last_byte() {
    // Two 8-byte keys that differ only in the final byte; strict mode so a
    // pack_key collision would defer instead of silently passing through.
    let plan = r#"[
        {"k":"object","keys":["abcdefgh","abcdefgi"],"values":[1,2],"optional":[false,false],"mode":"strict","catchall":null},
        {"k":"number","checks":[]},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"abcdefgh":1,"abcdefgi":2}"#), Scan::Clean);
}

#[test]
fn defer_mixed_short_and_long_keys_out_of_order() {
    // One key on the `words` path (8 bytes) and one on the `long` path (11
    // bytes), arriving out of order — the DOM walk must rewrite.
    let plan = r#"[
        {"k":"object","keys":["abcdefgh","verylongkey"],"values":[1,2],"optional":[false,false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(
        scan(plan, br#"{"verylongkey":2,"abcdefgh":1}"#),
        Scan::Defer
    );
}

#[test]
fn defer_duplicate_object_key() {
    let plan = r#"[
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"passthrough","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    // Duplicate keys collapse to the last value in the DOM walk; scanner must defer.
    assert_eq!(scan(plan, br#"{"a":1,"a":2}"#), Scan::Defer);
}

#[test]
fn defer_dirty_object_in_array_no_depth_underflow() {
    // A strip-mode object that sets dirty mid-array must not underflow the
    // depth counter when the array loop continues to the next element.
    let plan = r#"[
        {"k":"array","element":1,"checks":[]},
        {"k":"object","keys":["a"],"values":[2],"optional":[false],"mode":"strip","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"[{"a":1,"b":2},2]"#), Scan::Defer);
}

#[test]
fn clean_depth_128() {
    let depth = 128;
    let mut nodes: Vec<String> = Vec::with_capacity(depth + 1);
    for i in 0..depth {
        nodes.push(format!(
            "{{\"k\":\"array\",\"element\":{},\"checks\":[]}}",
            i + 1
        ));
    }
    nodes.push("{\"k\":\"number\",\"checks\":[]}".to_string());
    let plan = format!("[{}]", nodes.join(","));
    let input = format!(
        "{}1{}",
        iter::repeat_n('[', depth).collect::<String>(),
        iter::repeat_n(']', depth).collect::<String>()
    );
    assert_eq!(scan(&plan, input.as_bytes()), Scan::Clean);
}

#[test]
fn defer_depth_129() {
    let depth = 129;
    let mut nodes: Vec<String> = Vec::with_capacity(depth + 1);
    for i in 0..depth {
        nodes.push(format!(
            "{{\"k\":\"array\",\"element\":{},\"checks\":[]}}",
            i + 1
        ));
    }
    nodes.push("{\"k\":\"number\",\"checks\":[]}".to_string());
    let plan = format!("[{}]", nodes.join(","));
    let input = format!(
        "{}1{}",
        iter::repeat_n('[', depth).collect::<String>(),
        iter::repeat_n(']', depth).collect::<String>()
    );
    assert_eq!(scan(&plan, input.as_bytes()), Scan::Defer);
}

#[test]
fn clean_int64_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"bigint_format","v":"int64"}]}]"#;
    assert_eq!(scan(plan, b"9223372036854775807"), Scan::Clean);
}

#[test]
fn defer_int64_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"bigint_format","v":"int64"}]}]"#;
    // int64 max (2^63-1) rounds up to exactly 2^63 in f64, so 2^63 itself
    // still compares equal to the bound. 9223372036854777856 is the NEXT
    // representable f64 above it (ulp at 2^63 is 2048) — the tightest value
    // that can defer, so a loosened bound has nowhere to hide.
    assert_eq!(scan(plan, b"9223372036854777856"), Scan::Defer);
}

#[test]
fn clean_uint64_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"bigint_format","v":"uint64"}]}]"#;
    // 2^64 - 1 = 18446744073709551615; scanner uses f64 bounds so this probes
    // the 19-digit parse path and the lossy 2^64 boundary.
    assert_eq!(scan(plan, b"18446744073709551615"), Scan::Clean);
}

#[test]
fn defer_uint64_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"bigint_format","v":"uint64"}]}]"#;
    // Same one-ulp reasoning at the uint64 bound: 2^64 rounds to the bound,
    // and 18446744073709555712 is the next representable f64 (ulp 4096).
    assert_eq!(scan(plan, b"18446744073709555712"), Scan::Defer);
}

#[test]
fn defer_uint64_negative() {
    let plan = r#"[{"k":"number","checks":[{"c":"bigint_format","v":"uint64"}]}]"#;
    assert_eq!(scan(plan, b"-1"), Scan::Defer);
}

#[test]
fn clean_float32_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"float32"}]}]"#;
    assert_eq!(scan(plan, b"3.4028234663852886e38"), Scan::Clean);
}

#[test]
fn defer_float32_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"float32"}]}]"#;
    // One ulp above f32::MAX in f64 space — the tightest float32 rejection.
    assert_eq!(scan(plan, b"3.402823466385289e38"), Scan::Defer);
}

#[test]
fn clean_float64_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"float64"}]}]"#;
    // Every finite f64 clears the float64 range, so this only pins that the
    // scanner does not spuriously defer; `defer_float64_over` carries the
    // load-bearing half of the contract.
    assert_eq!(scan(plan, b"1.7976931348623157e308"), Scan::Clean);
}

#[test]
fn defer_float64_over() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"float64"}]}]"#;
    // 1e309 overflows to infinity. The range check cannot catch it (nothing
    // finite exceeds f64::MAX), so this pins `number_token`'s is_finite guard
    // — the only thing standing between an overflowing literal and a Clean
    // verdict that zod would reject.
    assert_eq!(scan(plan, b"1e309"), Scan::Defer);
}

#[test]
fn clean_catchall_unknown_string() {
    // Object with catchall string: unknown keys validated via catchall stay Clean
    let plan = r#"[
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":2},
        {"k":"number","checks":[]},
        {"k":"string","checks":[]}
    ]"#;
    assert_eq!(scan(plan, br#"{"a":1,"b":"hello"}"#), Scan::Clean);
}

#[test]
fn defer_catchall_unknown_dirty() {
    // Same catchall but with an overwrite check; unknown key value needing
    // trim rewrites -> dirty_hint -> Defer, distinct from strip/passthrough.
    let plan = r#"[
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strip","catchall":2},
        {"k":"number","checks":[]},
        {"k":"string","checks":[{"c":"overwrite","v":"trim","op":"trim"}]}
    ]"#;
    assert_eq!(scan(plan, br#"{"a":1,"b":"  hello  "}"#), Scan::Defer);
}

#[test]
fn defer_strict_unknown_key() {
    let plan = r#"[
        {"k":"object","keys":["a"],"values":[1],"optional":[false],"mode":"strict","catchall":null},
        {"k":"number","checks":[]}
    ]"#;
    // Strict mode unknown key is a hard failure -> Defer (not dirty write but still not Clean)
    assert_eq!(scan(plan, br#"{"a":1,"b":2}"#), Scan::Defer);
}

#[test]
fn bigint_plan_is_not_json_eligible() {
    // A bigint parses to a JS `BigInt`: no JSON encoding, and its bounds
    // arrive as decimal strings the f64 walk cannot compare. Letting such a
    // plan onto the byte path returned a `number` and skipped every bound
    // check, so `safeParseJson` accepted input `safeParse` rejected.
    // Mirrors `compilePlan`'s rule in packages/zodrs/src/core/plan.ts.
    let p = r#"[{"k":"bigint","checks":[{"c":"lt","v":"9223372036854775807","inclusive":true,"bigint":true}],"coerce":true}]"#;
    assert!(!compile(p).unwrap().json_eligible);
    // Nested behind a container, not just at the root.
    let nested = r#"[{"k":"object","keys":["id"],"values":[1],"optional":[false],"mode":"strip","catchall":null},{"k":"bigint","checks":[],"coerce":true}]"#;
    assert!(!compile(nested).unwrap().json_eligible);
    // A bigint-free sibling plan stays eligible, so the rule is not over-broad.
    let plain = r#"[{"k":"number","checks":[]}]"#;
    assert!(compile(plain).unwrap().json_eligible);
}
