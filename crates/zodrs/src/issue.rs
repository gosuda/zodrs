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

use std::borrow::Cow;

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

/// A borrowed path segment for the validation walk: schema keys and indices
/// need no allocation; only record keys (borrowed from the input DOM, whose
/// lifetime is shorter than the plan's) are pushed owned.
#[derive(Debug, Clone)]
pub enum PathSegRef<'a> {
    /// An object property name.
    Key(Cow<'a, str>),
    /// An array or tuple index.
    Index(u32),
}

impl PathSegRef<'_> {
    /// Converts to the owned segment stored in an emitted issue.
    pub(crate) fn to_owned_seg(&self) -> PathSeg {
        match self {
            PathSegRef::Key(k) => PathSeg::Key(k.clone().into_owned()),
            PathSegRef::Index(i) => PathSeg::Index(*i),
        }
    }
}

/// The path stack accumulated during a validation walk.
pub type PathRef<'a> = SmallVec<[PathSegRef<'a>; 8]>;

impl PathSeg {
    /// Renders this path segment as its JSON form (string key or number index).
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            PathSeg::Key(k) => Json::String(k.clone()),
            PathSeg::Index(i) => Json::Number((*i).into()),
        }
    }
}

/// The path stack accumulated during a validation walk.
pub type Path = SmallVec<[PathSeg; 8]>;

/// A single raw issue: a `path` and an ordered list of payload fields
/// (including `code`) whose insertion order mirrors the TS interpreter's
/// issue-construction sites exactly — the differential fuzz compares
/// serialized object key order.
#[derive(Debug, Clone)]
pub struct Issue {
    /// Location of the issue within the input value.
    pub path: Path,
    /// All payload fields including `code`, in canonical insertion order.
    pub fields: Vec<(&'static str, Json)>,
    /// Whether this issue aborts further validation (TS `continue: undefined`
    /// from `issue()`).  Check issues from `checkPayloadIssues()` set this
    /// to `false` (TS `continue: true`).  Not serialized — used only by
    /// union flattening to decide which branches are "nonaborted".
    pub aborting: bool,
}

impl Issue {
    /// Creates an aborting issue (TS `issue()`: `continue` is undefined).
    #[must_use]
    pub fn new(code: &'static str, path: &PathRef<'_>) -> Issue {
        Issue {
            path: path.iter().map(PathSegRef::to_owned_seg).collect(),
            fields: vec![("code", Json::String(code.to_string()))],
            aborting: true,
        }
    }

    /// Creates a non-aborting check issue (TS `checkPayloadIssues()`:
    /// `continue: true`).
    #[must_use]
    pub fn new_check(code: &'static str, path: &PathRef<'_>) -> Issue {
        Issue {
            path: path.iter().map(PathSegRef::to_owned_seg).collect(),
            fields: vec![("code", Json::String(code.to_string()))],
            aborting: false,
        }
    }

    /// Adds one payload field after the last field and returns the issue.
    #[must_use]
    pub fn with(mut self, key: &'static str, value: Json) -> Issue {
        self.fields.push((key, value));
        self
    }

    /// Inserts a field at position 0 (before `code`) and returns the issue.
    /// For codes whose canonical key order has `origin` or `expected` before
    /// `code` (e.g. `too_small`, `invalid_format`, `invalid_type`).
    #[must_use]
    pub fn insert_before_code(mut self, key: &'static str, value: Json) -> Issue {
        self.fields.insert(0, (key, value));
        self
    }

    /// Renders this issue as a JSON object with fields in insertion order,
    /// then `path` last.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        for (k, v) in &self.fields {
            m.insert((*k).to_string(), v.clone());
        }
        let path: Vec<Json> = self.path.iter().map(PathSeg::to_json).collect();
        m.insert("path".to_string(), Json::Array(path));
        Json::Object(m)
    }
}

/// Serializes a slice of issues as a JSON array string.
#[must_use]
pub fn issues_to_json(issues: &[Issue]) -> String {
    let arr: Vec<Json> = issues.iter().map(Issue::to_json).collect();
    serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into())
}

/// Serializes a slice of issues as a `serde_json::Value` array.
#[must_use]
pub fn issues_to_value(issues: &[Issue]) -> Json {
    Json::Array(issues.iter().map(Issue::to_json).collect())
}
