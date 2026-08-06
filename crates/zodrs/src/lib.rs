//! zodrs: plan-based JSON validation engine.
//!
//! Pure Rust, no napi dependency. Consumes a compiled [`plan::Plan`] and
//! validates raw JSON bytes against it. The napi bindings live in
//! `crates/zodrs-node`.

pub mod compile;
pub mod formats;
pub mod issue;
pub mod jsonschema;
pub mod plan;
pub mod validate;

pub use compile::{compile, CompileError, CompiledPlan};
pub use issue::{issues_to_json, Issue, Path, PathSeg};
pub use plan::{Check, NodeId, PlanNode, RawPlan};
pub use validate::{validate, Verdict};
