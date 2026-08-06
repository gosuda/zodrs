//! Issue wire format.
//!
//! Rust emits `$ZodRawIssue`-shaped objects — the finalized `$ZodIssue` minus
//! `input`, `message`, and the internal `inst`/`continue` fields (see
//! `.references/zod/packages/zod/src/v4/core/util.ts` `finalizeIssue`). The TS
//! side back-fills `input` by walking the path and resolves `message` through
//! the error-map precedence chain. Field names mirror
//! `.references/zod/packages/zod/src/v4/core/errors.ts` exactly.
//!
//! The whole batch serializes as one JSON array.

use serde_json::{Map, Value as Json};
use smallvec::SmallVec;

/// One segment of an issue path: an object key or an array/tuple index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    /// An object property name.
    Key(String),
    /// An array or tuple index.
    Index(u32),
}

impl PathSeg {
    fn to_json(&self) -> Json {
        match self {
            PathSeg::Key(k) => Json::String(k.clone()),
            PathSeg::Index(i) => Json::Number((*i).into()),
        }
    }
}

/// The path stack accumulated during a validation walk.
pub type Path = SmallVec<[PathSeg; 8]>;

/// A single raw issue: a `code`, a `path`, and the code-specific payload
/// fields, all order-independent under JSON object equality.
#[derive(Debug, Clone)]
pub struct Issue {
    /// Zod issue code, e.g. `too_small` or `invalid_type`.
    pub code: &'static str,
    /// Location of the issue within the input value.
    pub path: Path,
    /// Extra payload fields, e.g. `origin`, `minimum`, `format`.
    pub fields: Vec<(&'static str, Json)>,
}

impl Issue {
    /// Creates an issue with the given code at the current path.
    #[must_use]
    pub fn new(code: &'static str, path: &Path) -> Issue {
        Issue {
            code,
            path: path.clone(),
            fields: Vec::new(),
        }
    }

    /// Adds one payload field and returns the issue for chaining.
    #[must_use]
    pub fn with(mut self, key: &'static str, value: Json) -> Issue {
        self.fields.push((key, value));
        self
    }

    /// Renders this issue as a JSON object.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("code".to_string(), Json::String(self.code.to_string()));
        for (k, v) in &self.fields {
            m.insert((*k).to_string(), v.clone());
        }
        let path: Vec<Json> = self.path.iter().map(PathSeg::to_json).collect();
        m.insert("path".to_string(), Json::Array(path));
        Json::Object(m)
    }
}

/// Serializes a batch of issues as one JSON array string.
///
/// # Panics
///
/// Panics only if `serde_json` fails to serialize a `Value` array, which cannot
/// happen for well-formed issues.
#[must_use]
#[allow(clippy::expect_used, reason = "serializing a Value array is infallible")]
pub fn issues_to_json(issues: &[Issue]) -> String {
    let arr = Json::Array(issues.iter().map(Issue::to_json).collect());
    serde_json::to_string(&arr).expect("issue array is always serializable")
}

/// Serializes a batch of issues as a raw `serde_json::Value` (for nesting
/// inside `invalid_union` / `invalid_key` / `invalid_element` payloads).
#[must_use]
pub fn issues_to_value(issues: &[Issue]) -> Json {
    Json::Array(issues.iter().map(Issue::to_json).collect())
}
