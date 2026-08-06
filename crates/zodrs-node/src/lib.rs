//! napi bindings over `zodrs`.
//!
//! Exposes exactly three functions — `compile`, `dispose`, and `validate_json`
//! — and nothing else. Compiled plans live in a process-wide
//! `RwLock<Slab<CompiledPlan>>` keyed by `u32` handle; validation only ever
//! takes the read side of the lock. The Rust core never calls back into
//! JavaScript.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use slab::Slab;
use std::sync::{LazyLock, RwLock};
use zodrs::CompiledPlan;

/// Process-wide registry of compiled plans, keyed by slab index.
static PLANS: LazyLock<RwLock<Slab<CompiledPlan>>> =
    LazyLock::new(|| RwLock::new(Slab::new()));

/// The result of a byte-path validation, mirroring the JS-facing contract.
///
/// `status` is 0 when the input bytes are already canonical, 1 when `payload`
/// holds the canonical output JSON, 2 when `payload` holds the raw issue array
/// JSON, and 3 when the plan is not JSON-eligible or the input could not be
/// parsed — the caller then uses the TypeScript path.
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// Verdict code: 0 valid-canonical, 1 valid-rewritten, 2 invalid, 3
    /// fall back to the JS path.
    pub status: u8,
    /// Output or issue JSON, present for statuses 1 and 2 only.
    pub payload: Option<String>,
}

impl From<zodrs::Verdict> for Verdict {
    fn from(v: zodrs::Verdict) -> Verdict {
        Verdict {
            status: v.status,
            payload: v.payload,
        }
    }
}

fn lock_error(op: &str) -> Error {
    Error::new(Status::GenericFailure, format!("plan registry lock poisoned on {op}"))
}

/// Compiles a serialized plan and registers it in the slab.
///
/// # Errors
///
/// Returns an error when the plan JSON cannot be deserialized or when its
/// arena is structurally invalid.
#[napi]
#[allow(
    clippy::needless_pass_by_value,
    reason = "napi boundary: JS passes the plan JSON by value across the FFI"
)]
pub fn compile(plan_json: String) -> Result<u32> {
    let plan = zodrs::compile(&plan_json).map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
    let mut plans = PLANS.write().map_err(|_| lock_error("compile"))?;
    let key = plans.insert(plan);
    Ok(u32::try_from(key).unwrap_or(u32::MAX))
}

/// Removes a compiled plan from the slab. Unknown handles are a no-op.
#[napi]
pub fn dispose(plan: u32) {
    if let Ok(mut plans) = PLANS.write() {
        let index = plan as usize;
        if plans.contains(index) {
            plans.remove(index);
        }
    }
}

/// Validates raw JSON bytes against a compiled plan. The hot path.
///
/// # Errors
///
/// Returns an error when `plan` is not a registered handle.
#[napi]
#[allow(
    clippy::needless_pass_by_value,
    reason = "napi boundary: the Uint8Array handle arrives by value from JS"
)]
pub fn validate_json(plan: u32, input: Uint8Array) -> Result<Verdict> {
    let plans = PLANS.read().map_err(|_| lock_error("validate_json"))?;
    let index = plan as usize;
    let Some(compiled) = plans.get(index) else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("unknown plan handle {plan}"),
        ));
    };
    Ok(zodrs::validate(compiled, input.as_ref()).into())
}
