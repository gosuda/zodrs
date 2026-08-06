//! Plan compilation: deserialized plan -> validated arena with precomputed
//! dispatch tables (sorted object key indexes, discriminated-union maps, and
//! compiled regex/format validators).

use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use regex::{Regex, RegexBuilder};
use serde_json::Value as Json;

use crate::formats::{self, FormatValidator};
use crate::plan::{Check, NodeId, PlanNode, RawPlan};

/// A plan ready for the hot validation path.
#[derive(Debug)]
pub struct CompiledPlan {
    /// The deserialized plan arena and root index.
    pub raw: RawPlan,
    /// Whether the plan can be validated entirely over JSON bytes in Rust.
    pub json_eligible: bool,
    pub(crate) dispatch: Vec<NodeDispatch>,
}

impl CompiledPlan {
    /// Returns the flat node arena.
    #[must_use]
    pub fn nodes(&self) -> &[PlanNode] {
        &self.raw.nodes
    }

    /// Returns the arena index at which validation begins.
    #[must_use]
    pub fn root(&self) -> NodeId {
        self.raw.root
    }
}

#[derive(Debug, Default)]
pub(crate) struct NodeDispatch {
    pub object: Option<ObjectDispatch>,
    pub disc_union: Option<HashMap<LiteralValue, NodeId>>,
    pub checks: Vec<Option<CompiledCheck>>,
    pub template: Option<Regex>,
}

/// Sorted `(schema key, original schema index)` pairs. The hot lookup starts
/// with a `memchr` first-byte screen before the exact comparison.
#[derive(Debug)]
pub(crate) struct ObjectDispatch {
    pub sorted_keys: Vec<(String, usize)>,
    /// First byte of every schema key, used as a memchr pre-screen.
    pub first_bytes: Vec<u8>,
}

impl ObjectDispatch {
    pub fn find(&self, key: &str) -> Option<usize> {
        // memchr first-byte pre-screen, skipped for the empty key (which has
        // no first byte); then an exact binary search.
        if let Some(&first) = key.as_bytes().first()
            && memchr::memchr(first, &self.first_bytes).is_none()
        {
            return None;
        }
        self.sorted_keys
            .binary_search_by(|(candidate, _)| candidate.as_str().cmp(key))
            .ok()
            .map(|i| self.sorted_keys[i].1)
    }
}

#[derive(Debug)]
pub(crate) enum CompiledCheck {
    Regex(Regex),
    Format(FormatValidator),
}

/// Hashable primitive value for discriminated-union dispatch.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum LiteralValue {
    String(String),
    Number(u64),
    Bool(bool),
    Null,
}

impl LiteralValue {
    pub fn from_json(v: &Json) -> Option<LiteralValue> {
        match v {
            Json::String(s) => Some(LiteralValue::String(s.clone())),
            Json::Number(n) => n.as_f64().map(|n| {
                // JS Map uses SameValueZero; normalize negative zero.
                LiteralValue::Number(if n == 0.0 { 0 } else { n.to_bits() })
            }),
            Json::Bool(b) => Some(LiteralValue::Bool(*b)),
            Json::Null => Some(LiteralValue::Null),
            _ => None,
        }
    }

    /// Build from a parsed `sonic_rs` value at runtime.
    pub fn from_value(v: &sonic_rs::Value) -> Option<LiteralValue> {
        use sonic_rs::JsonValueTrait;
        if let Some(s) = v.as_str() {
            return Some(LiteralValue::String(s.to_string()));
        }
        if let Some(b) = v.as_bool() {
            return Some(LiteralValue::Bool(b));
        }
        if v.is_null() {
            return Some(LiteralValue::Null);
        }
        if v.is_number() {
            return v
                .as_f64()
                .map(|n| LiteralValue::Number(if n == 0.0 { 0 } else { n.to_bits() }));
        }
        None
    }
}

/// Error returned when a plan's JSON is malformed or its arena is invalid.
#[derive(Debug)]
pub struct CompileError {
    message: String,
}

impl CompileError {
    fn new(message: impl Into<String>) -> CompileError {
        CompileError {
            message: message.into(),
        }
    }
}

impl Display for CompileError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for CompileError {}

impl From<serde_json::Error> for CompileError {
    fn from(value: serde_json::Error) -> Self {
        CompileError::new(format!("invalid plan JSON: {value}"))
    }
}

/// Deserializes and compiles a plan.
///
/// A host node/check or a regex that Rust's linear-time `regex` crate cannot
/// compile does *not* fail the cold-path call; it marks the plan
/// non-JSON-eligible so the TypeScript wrapper routes the whole schema to its
/// JS validator.
///
/// # Errors
///
/// Returns a [`CompileError`] when the plan JSON cannot be deserialized or when
/// an arena edge references a missing node.
pub fn compile(plan_json: &str) -> Result<CompiledPlan, CompileError> {
    let raw = RawPlan::from_json(plan_json)?;
    validate_arena(&raw)?;

    let mut eligible = true;
    let mut dispatch = Vec::with_capacity(raw.nodes.len());

    for node in &raw.nodes {
        let mut d = NodeDispatch::default();

        match node {
            PlanNode::Object { keys, .. } => {
                let mut sorted_keys: Vec<(String, usize)> =
                    keys.iter().cloned().enumerate().map(|(i, k)| (k, i)).collect();
                sorted_keys.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                let first_bytes = sorted_keys
                    .iter()
                    .map(|(key, _)| key.as_bytes().first().copied().unwrap_or(0))
                    .collect();
                d.object = Some(ObjectDispatch {
                    sorted_keys,
                    first_bytes,
                });
            }
            PlanNode::DiscUnion { map, .. } => {
                let mut compiled = HashMap::with_capacity(map.len());
                for (literal, id) in map {
                    match LiteralValue::from_json(literal) {
                        Some(k) => {
                            compiled.insert(k, *id);
                        }
                        None => eligible = false,
                    }
                }
                d.disc_union = Some(compiled);
            }
            PlanNode::TemplateLiteral { pattern } => match Regex::new(pattern) {
                Ok(r) => d.template = Some(r),
                Err(_) => eligible = false,
            },
            PlanNode::Host { .. }
            | PlanNode::Default { dynamic: true, .. }
            | PlanNode::Prefault { dynamic: true, .. }
            | PlanNode::Catch { dynamic: true, .. } => eligible = false,
            _ => {}
        }

        if let Some(checks) = node_checks(node) {
            d.checks.reserve(checks.len());
            for check in checks {
                let compiled = match check {
                    Check::Regex { src, flags } => compile_js_regex(src, flags).map_or_else(
                        |()| {
                            eligible = false;
                            None
                        },
                        |r| Some(CompiledCheck::Regex(r)),
                    ),
                    Check::Format { v, params } => {
                        formats::compile(v, params.as_ref()).map_or_else(
                            |_| {
                                eligible = false;
                                None
                            },
                            |f| Some(CompiledCheck::Format(f)),
                        )
                    }
                    Check::Host { .. } => {
                        eligible = false;
                        None
                    }
                    _ => None,
                };
                d.checks.push(compiled);
            }
        }

        dispatch.push(d);
    }

    Ok(CompiledPlan {
        raw,
        json_eligible: eligible,
        dispatch,
    })
}

fn node_checks(node: &PlanNode) -> Option<&[Check]> {
    match node {
        PlanNode::String { checks, .. }
        | PlanNode::Number { checks, .. }
        | PlanNode::BigInt { checks, .. }
        | PlanNode::Date { checks, .. }
        | PlanNode::File { checks }
        | PlanNode::Array { checks, .. }
        | PlanNode::Map { checks, .. }
        | PlanNode::Set { checks, .. } => Some(checks),
        _ => None,
    }
}

/// Compile a JS regex source/flags pair with the compatible Rust options.
/// Global/sticky/indices flags are stateful JS execution controls and do not
/// change a one-shot validation match, so `g`, `y`, and `d` are ignored.
fn compile_js_regex(src: &str, flags: &str) -> Result<Regex, ()> {
    let mut builder = RegexBuilder::new(src);
    for flag in flags.chars() {
        match flag {
            'i' => {
                builder.case_insensitive(true);
            }
            'm' => {
                builder.multi_line(true);
            }
            's' => {
                builder.dot_matches_new_line(true);
            }
            'u' | 'g' | 'y' | 'd' => {}
            _ => return Err(()),
        }
    }
    builder.build().map_err(|_| ())
}

/// Check every arena edge once at compile time so the validation walk may
/// index directly without branches. Cycles are valid; out-of-bounds edges are
/// not.
fn validate_arena(plan: &RawPlan) -> Result<(), CompileError> {
    let len = plan.nodes.len();
    if len == 0 {
        return Err(CompileError::new("plan node arena is empty"));
    }
    edge(plan.root, len, "root")?;

    for (at, node) in plan.nodes.iter().enumerate() {
        let here = |field: &str| format!("node {at} {field}");
        match node {
            PlanNode::Object {
                keys,
                values,
                optional,
                catchall,
                ..
            } => {
                if keys.len() != values.len() || keys.len() != optional.len() {
                    return Err(CompileError::new(format!(
                        "node {at} object keys/values/optional lengths differ"
                    )));
                }
                for id in values {
                    edge(*id, len, &here("object value"))?;
                }
                if let Some(id) = catchall {
                    edge(*id, len, &here("object catchall"))?;
                }
            }
            PlanNode::Array { element, checks } => {
                edge(*element, len, &here("array element"))?;
                check_edges(checks, len, at)?;
            }
            PlanNode::Tuple { items, rest } => {
                for id in items {
                    edge(*id, len, &here("tuple item"))?;
                }
                if let Some(id) = rest {
                    edge(*id, len, &here("tuple rest"))?;
                }
            }
            PlanNode::Union { options } => {
                for id in options {
                    edge(*id, len, &here("union option"))?;
                }
            }
            PlanNode::DiscUnion { map, .. } => {
                for (_, id) in map {
                    edge(*id, len, &here("discriminated-union option"))?;
                }
            }
            PlanNode::Intersection { left, right } => {
                edge(*left, len, &here("intersection left"))?;
                edge(*right, len, &here("intersection right"))?;
            }
            PlanNode::Record { key, value } => {
                edge(*key, len, &here("record key"))?;
                edge(*value, len, &here("record value"))?;
            }
            PlanNode::Map { key, value, checks } => {
                if let Some(id) = key {
                    edge(*id, len, &here("map key"))?;
                }
                edge(*value, len, &here("map value"))?;
                check_edges(checks, len, at)?;
            }
            PlanNode::Set { value, checks } => {
                edge(*value, len, &here("set value"))?;
                check_edges(checks, len, at)?;
            }
            PlanNode::Optional { inner }
            | PlanNode::Nullable { inner }
            | PlanNode::NonOptional { inner }
            | PlanNode::Readonly { inner }
            | PlanNode::Lazy { inner }
            | PlanNode::Promise { inner }
            | PlanNode::Default { inner, .. }
            | PlanNode::Prefault { inner, .. }
            | PlanNode::Catch { inner, .. } => edge(*inner, len, &here("inner"))?,
            PlanNode::Pipe { a, b } => {
                edge(*a, len, &here("pipe a"))?;
                edge(*b, len, &here("pipe b"))?;
            }
            PlanNode::Host {
                inner: Some(id), ..
            } => edge(*id, len, &here("host inner"))?,
            PlanNode::String { checks, .. }
            | PlanNode::Number { checks, .. }
            | PlanNode::BigInt { checks, .. }
            | PlanNode::Date { checks, .. }
            | PlanNode::File { checks } => check_edges(checks, len, at)?,
            _ => {}
        }
    }
    Ok(())
}

fn check_edges(checks: &[Check], len: usize, at: usize) -> Result<(), CompileError> {
    for check in checks {
        if let Check::Property { node, .. } = check {
            edge(*node, len, &format!("node {at} property check"))?;
        }
    }
    Ok(())
}

fn edge(id: NodeId, len: usize, field: &str) -> Result<(), CompileError> {
    if id as usize >= len {
        Err(CompileError::new(format!(
            "{field} references missing node {id} (arena length {len})"
        )))
    } else {
        Ok(())
    }
}
