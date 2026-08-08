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
/// Byte-scanner fast path. Exposed for integration tests; not a stable API.
#[doc(hidden)]
pub mod scan;
pub mod validate;

pub use compile::{CompileError, CompiledPlan, compile};
pub use issue::{Issue, Path, PathSeg, issues_to_json};
pub use plan::{Check, NodeId, PlanNode, RawPlan};
pub use validate::{Verdict, validate};
