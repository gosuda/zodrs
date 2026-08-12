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

use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use smallvec::SmallVec;
use sonic_rs::Value as Json;

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
            fields: vec![("code", Json::from(code))],
            aborting: true,
        }
    }

    /// Creates a non-aborting check issue (TS `checkPayloadIssues()`:
    /// `continue: true`).
    #[must_use]
    pub fn new_check(code: &'static str, path: &PathRef<'_>) -> Issue {
        Issue {
            path: path.iter().map(PathSegRef::to_owned_seg).collect(),
            fields: vec![("code", Json::from(code))],
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
}

/// Serializes a slice of issues as a JSON array string.
#[must_use]
pub fn issues_to_json(issues: &[Issue]) -> String {
    sonic_rs::to_string(&IssueList(issues)).unwrap_or_else(|_| "[]".into())
}

/// Wrapper that writes a batch of issues as a JSON array without building
/// an intermediate value tree.
struct IssueList<'a>(&'a [Issue]);

impl Serialize for IssueList<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for issue in self.0 {
            seq.serialize_element(&IssueWire(issue))?;
        }
        seq.end()
    }
}

/// Wrapper that writes one issue as a JSON object with fields in the order
/// they were pushed, followed by `path`.
struct IssueWire<'a>(&'a Issue);

impl Serialize for IssueWire<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = &self.0.fields;
        let unique_fields = fields
            .iter()
            .enumerate()
            .filter(|(i, (key, _))| !fields[..*i].iter().any(|(prior, _)| prior == key))
            .count();
        let has_path = fields.iter().any(|(key, _)| *key == "path");
        let mut map = serializer.serialize_map(Some(unique_fields + usize::from(!has_path)))?;

        for (i, (key, value)) in fields.iter().enumerate() {
            if fields[..i].iter().any(|(prior, _)| prior == key) {
                continue;
            }
            if *key == "path" {
                map.serialize_entry("path", &PathWire(&self.0.path))?;
                continue;
            }
            let value = fields[i + 1..]
                .iter()
                .rev()
                .find_map(|(candidate, value)| (candidate == key).then_some(value))
                .unwrap_or(value);
            map.serialize_entry(*key, value)?;
        }
        if !has_path {
            map.serialize_entry("path", &PathWire(&self.0.path))?;
        }
        map.end()
    }
}

/// Wrapper that writes an issue path as a JSON array of strings/indices.
struct PathWire<'a>(&'a Path);

impl Serialize for PathWire<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for seg in self.0 {
            seq.serialize_element(seg)?;
        }
        seq.end()
    }
}

impl Serialize for PathSeg {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            PathSeg::Key(k) => serializer.serialize_str(k),
            PathSeg::Index(i) => serializer.serialize_u32(*i),
        }
    }
}

/// Renders a slice of issues as a JSON array value.
///
/// A mutable `sonic_rs::Object` is hash-backed, so building one key by key
/// loses the insertion order the wire depends on. Parsing the ordered
/// serialized form keeps the order in the document-backed value.
#[must_use]
pub fn issues_to_value(issues: &[Issue]) -> Json {
    sonic_rs::from_str(&issues_to_json(issues)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use smallvec::smallvec;
    use sonic_rs::json;

    use super::{Issue, PathSegRef, issues_to_json, issues_to_value};

    fn path_ref(s: &str) -> super::PathRef<'_> {
        smallvec![PathSegRef::Key(Cow::Borrowed(s))]
    }

    /// The wire is the contract, so every case pins the exact bytes and then
    /// re-serializes the parsed value. The second assert proves the value
    /// form keeps the field order that a hash-backed object would lose.
    fn assert_wire(issues: &[Issue], expected: &str) {
        assert_eq!(issues_to_json(issues), expected);
        assert_eq!(
            sonic_rs::to_string(&issues_to_value(issues)).unwrap_or_default(),
            expected
        );
    }

    #[test]
    fn wire_simple() {
        let issues = vec![
            Issue::new("invalid_type", &path_ref("a")).with("expected", json!("number")),
            Issue::new_check("too_small", &path_ref("b"))
                .with("origin", json!("array"))
                .with("minimum", json!(3))
                .with("inclusive", json!(true)),
        ];
        assert_wire(
            &issues,
            r#"[{"code":"invalid_type","expected":"number","path":["a"]},{"code":"too_small","origin":"array","minimum":3,"inclusive":true,"path":["b"]}]"#,
        );
    }

    #[test]
    fn wire_nested_issues_keep_order() {
        let nested =
            vec![Issue::new("invalid_type", &path_ref("c")).with("expected", json!("string"))];
        let parent = Issue::new("invalid_key", &path_ref("root"))
            .with("origin", json!("record"))
            .with("issues", issues_to_value(&nested));
        assert_wire(
            &[parent],
            r#"[{"code":"invalid_key","origin":"record","issues":[{"code":"invalid_type","expected":"string","path":["c"]}],"path":["root"]}]"#,
        );
    }

    #[test]
    fn wire_numbers_and_index_path() {
        let mut p = path_ref("items");
        p.push(PathSegRef::Index(2));
        let issue = Issue::new_check("too_big", &p)
            .with("origin", json!("array"))
            .with("maximum", json!(5.5))
            .with("inclusive", json!(false));
        assert_wire(
            &[issue],
            r#"[{"code":"too_big","origin":"array","maximum":5.5,"inclusive":false,"path":["items",2]}]"#,
        );
    }

    #[test]
    fn wire_duplicate_fields_shadow_and_path_never_spoofs() {
        let issue = Issue::new("invalid_type", &path_ref("actual"))
            .with("origin", json!("first"))
            .with("code", json!("custom"))
            .with("path", json!(["spoofed"]))
            .with("origin", json!("last"));
        assert_wire(
            &[issue],
            r#"[{"code":"custom","origin":"last","path":["actual"]}]"#,
        );
    }
}
