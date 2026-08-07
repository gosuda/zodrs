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
        nodes.push(format!("{{\"k\":\"array\",\"element\":{},\"checks\":[]}}", i + 1));
    }
    nodes.push("{\"k\":\"number\",\"checks\":[]}".to_string());
    let plan = format!("[{}]", nodes.join(","));
    let input = format!("{}1{}", iter::repeat_n('[', depth).collect::<String>(), iter::repeat_n(']', depth).collect::<String>());
    assert_eq!(scan(&plan, input.as_bytes()), Scan::Clean);
}

#[test]
fn defer_depth_129() {
    let depth = 129;
    let mut nodes: Vec<String> = Vec::with_capacity(depth + 1);
    for i in 0..depth {
        nodes.push(format!("{{\"k\":\"array\",\"element\":{},\"checks\":[]}}", i + 1));
    }
    nodes.push("{\"k\":\"number\",\"checks\":[]}".to_string());
    let plan = format!("[{}]", nodes.join(","));
    let input = format!("{}1{}", iter::repeat_n('[', depth).collect::<String>(), iter::repeat_n(']', depth).collect::<String>());
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
    // 1e19 is clearly > int64 max (9.22e18) in f64, unlike 9223372036854775808 which rounds to max
    assert_eq!(scan(plan, b"1e19"), Scan::Defer);
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
    // 2e19 is clearly > uint64 max (1.84e19) in f64
    assert_eq!(scan(plan, b"2e19"), Scan::Defer);
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
    assert_eq!(scan(plan, b"6e38"), Scan::Defer);
}

#[test]
fn clean_float64_max() {
    let plan = r#"[{"k":"number","checks":[{"c":"number_format","v":"float64"}]}]"#;
    // 1.7976931348623157e308 is near f64::MAX; any finite JSON number is Clean
    // for float64, but this pins the scanner does not spuriously Defer.
    assert_eq!(scan(plan, b"1.7976931348623157e308"), Scan::Clean);
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
