#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

//! Regression guards for free-form JSON values in the plan wire.
//!
//! `PlanNode` and `Check` are internally tagged, so serde buffers every node
//! into `Content` before dispatching on `k` / `c`. A bare `sonic_rs::Value`
//! field cannot be replayed from that buffer, and a `Value` rebuilt by
//! mutation is hash-backed, so object key order would be lost. Both failures
//! are silent at the type level: the first turns every affected plan into a
//! compile error, the second reorders canonical output. `crate::wire` handles
//! both, and these tests pin the behavior.
//!
//! `wire::json_pairs` (`DiscUnion.map`) needs no case here: dropping its
//! annotation already fails the discriminated-union cases in `core.rs`.

use zodrs::{compile, validate};

fn ok(plan: &str) -> zodrs::CompiledPlan {
    match compile(plan) {
        Ok(compiled) => compiled,
        Err(e) => panic!("plan must compile: {e}"),
    }
}

/// Every check that carries a free-form `v` or `params` value. A missing
/// `deserialize_with` on any of them fails the whole plan, not just the check.
/// Each row validates a passing and a failing input, so the value has to
/// reach the validator rather than merely parse.
#[test]
fn checks_with_free_form_values_reach_the_validator() {
    for (plan, pass, fail) in [
        (
            r#"[{"k":"number","checks":[{"c":"gt","v":0,"inclusive":false}]}]"#,
            "5",
            "0",
        ),
        (
            r#"[{"k":"number","checks":[{"c":"lt","v":10,"inclusive":true}]}]"#,
            "10",
            "11",
        ),
        (
            r#"[{"k":"number","checks":[{"c":"multiple_of","v":3}]}]"#,
            "9",
            "8",
        ),
        (
            r#"[{"k":"string","checks":[{"c":"format","v":"datetime","params":{"precision":3}}]}]"#,
            r#""2024-01-01T00:00:00.000Z""#,
            r#""2024-01-01T00:00:00Z""#,
        ),
        (
            r#"[{"k":"literal","values":["a",1,true,null]}]"#,
            r#""a""#,
            r#""b""#,
        ),
        (r#"[{"k":"enum","values":["a","b"]}]"#, r#""b""#, r#""c""#),
    ] {
        let compiled = ok(plan);
        assert_eq!(
            validate(&compiled, pass.as_bytes()).status,
            0,
            "{pass} must pass {plan}"
        );
        assert_eq!(
            validate(&compiled, fail.as_bytes()).status,
            2,
            "{fail} must fail {plan}"
        );
    }
}

/// The tag may arrive after the value fields: `JSON.stringify` of a plan built
/// from a hash-backed object emits keys in arbitrary order.
#[test]
fn tag_position_does_not_matter() {
    let compiled = ok(r#"[{"checks":[{"v":0,"inclusive":false,"c":"gt"}],"k":"number"}]"#);
    assert_eq!(validate(&compiled, b"5").status, 0);
    assert_eq!(validate(&compiled, b"0").status, 2);
}

/// Canonical output writes a plan default verbatim, so the default's own key
/// order is observable. Rebuilding the value through a hash-backed object
/// would scramble it; only the alphabetical accident would hide the bug, so
/// the fixture is deliberately unsorted.
#[test]
fn default_object_keeps_plan_key_order() {
    let compiled = ok(r#"[
        {"k":"object","keys":["cfg"],"values":[1],"optional":[true],"mode":"strip"},
        {"k":"default","inner":2,"value":{"zeta":1,"alpha":2,"mid":3}},
        {"k":"object","keys":["zeta","alpha","mid"],"values":[3,3,3],"optional":[false,false,false],"mode":"strip"},
        {"k":"number","checks":[{"c":"gt","v":0,"inclusive":false}]}
    ]"#);

    let verdict = validate(&compiled, b"{}");
    assert_eq!(verdict.status, 1, "default must rewrite the output");
    assert_eq!(
        verdict.payload.as_deref(),
        Some(r#"{"cfg":{"zeta":1,"alpha":2,"mid":3}}"#)
    );
}

/// A nested default array of objects exercises the sequence and map writers
/// together.
#[test]
fn default_nested_containers_keep_order() {
    let compiled = ok(r#"[
        {"k":"object","keys":["rows"],"values":[1],"optional":[true],"mode":"strip"},
        {"k":"default","inner":2,"value":[{"b":1,"a":2},{"d":3,"c":4}]},
        {"k":"array","element":3},
        {"k":"object","keys":["b","a","d","c"],"values":[4,4,4,4],"optional":[true,true,true,true],"mode":"passthrough"},
        {"k":"number"}
    ]"#);

    let verdict = validate(&compiled, b"{}");
    assert_eq!(verdict.status, 1);
    assert_eq!(
        verdict.payload.as_deref(),
        Some(r#"{"rows":[{"b":1,"a":2},{"d":3,"c":4}]}"#)
    );
}
