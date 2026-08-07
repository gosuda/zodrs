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
    pub disc_union: Option<DiscUnionDispatch>,
    pub checks: Vec<Option<CompiledCheck>>,
    pub template: Option<Regex>,
    /// Whether the schema accepts `undefined` as input (zod `_zod.optin`).
    pub optin_optional: bool,
    /// Whether the schema can produce `undefined` as output (zod `_zod.optout`).
    pub optout_optional: bool,
}

/// Discriminated-union dispatch, split by literal kind so the hot lookup
/// matches a borrowed `&str`/`f64` without building an owned key.
#[derive(Debug, Default)]
pub(crate) struct DiscUnionDispatch {
    strings: HashMap<String, NodeId>,
    numbers: HashMap<u64, NodeId>,
    bools: [Option<NodeId>; 2],
    null: Option<NodeId>,
}

impl DiscUnionDispatch {
    /// Insert a compile-time literal from the plan's discriminant map.
    fn insert(&mut self, lit: LiteralValue, id: NodeId) {
        match lit {
            LiteralValue::String(s) => {
                self.strings.insert(s, id);
            }
            LiteralValue::Number(n) => {
                self.numbers.insert(n, id);
            }
            LiteralValue::Bool(b) => self.bools[usize::from(b)] = Some(id),
            LiteralValue::Null => self.null = Some(id),
        }
    }

    /// Look up the option for a parsed discriminant value.
    pub fn find_value(&self, v: &sonic_rs::Value) -> Option<NodeId> {
        use sonic_rs::JsonValueTrait;
        if let Some(s) = v.as_str() {
            return self.strings.get(s).copied();
        }
        if let Some(b) = v.as_bool() {
            return self.bools[usize::from(b)];
        }
        if v.is_null() {
            return self.null;
        }
        if v.is_number() {
            return v
                .as_f64()
                .and_then(|n| self.numbers.get(&number_key(n)).copied());
        }
        None
    }

    /// String discriminant lookup for the byte scanner.
    pub fn find_str(&self, s: &str) -> Option<NodeId> {
        self.strings.get(s).copied()
    }

    /// Boolean discriminant lookup for the byte scanner.
    pub fn find_bool(&self, b: bool) -> Option<NodeId> {
        self.bools[usize::from(b)]
    }

    /// Null discriminant lookup for the byte scanner.
    pub fn find_null(&self) -> Option<NodeId> {
        self.null
    }

    /// Number discriminant lookup for the byte scanner.
    pub fn find_number(&self, n: f64) -> Option<NodeId> {
        self.numbers.get(&number_key(n)).copied()
    }
}

/// Per-node object key index. Keys of up to 8 bytes are packed into a
/// little-endian `u64` word so matching is two integer compares per
/// candidate — no per-probe hashing or `memcmp` call. Longer keys are rare
/// and match by length-then-bytes.
#[derive(Debug)]
pub(crate) struct ObjectDispatch {
    /// Packed keys up to 8 bytes long.
    words: Vec<KeyWord>,
    /// Keys longer than 8 bytes.
    long: Vec<(String, usize)>,
}

/// A schema key packed into a machine word.
#[derive(Debug)]
struct KeyWord {
    word: u64,
    len: usize,
    schema_i: usize,
}

/// Packs a key of at most 8 bytes into a little-endian word.
fn pack_key(kb: &[u8]) -> u64 {
    let mut w: u64 = 0;
    for (i, &c) in kb.iter().enumerate() {
        w |= u64::from(c) << (8 * i);
    }
    w
}

impl ObjectDispatch {
    pub fn find(&self, key: &str) -> Option<usize> {
        self.find_bytes(key.as_bytes())
    }

    /// Byte-level lookup: schema keys are valid UTF-8, so byte equality and
    /// string equality coincide.
    pub fn find_bytes(&self, kb: &[u8]) -> Option<usize> {
        if kb.len() <= 8 {
            let w = pack_key(kb);
            for kw in &self.words {
                if kw.len == kb.len() && kw.word == w {
                    return Some(kw.schema_i);
                }
            }
            None
        } else {
            for (candidate, schema_i) in &self.long {
                let cb = candidate.as_bytes();
                if cb.len() == kb.len() && cb == kb {
                    return Some(*schema_i);
                }
            }
            None
        }
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

/// `SameValueZero` number key: negative zero folds to positive zero.
fn number_key(n: f64) -> u64 {
    if n == 0.0 { 0 } else { n.to_bits() }
}

impl LiteralValue {
    pub fn from_json(v: &Json) -> Option<LiteralValue> {
        match v {
            Json::String(s) => Some(LiteralValue::String(s.clone())),
            Json::Number(n) => n.as_f64().map(|n| LiteralValue::Number(number_key(n))),
            Json::Bool(b) => Some(LiteralValue::Bool(*b)),
            Json::Null => Some(LiteralValue::Null),
            _ => None,
        }
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
                let mut words = Vec::with_capacity(keys.len());
                let mut long = Vec::new();
                for (schema_i, key) in keys.iter().enumerate() {
                    let kb = key.as_bytes();
                    if kb.len() <= 8 {
                        words.push(KeyWord {
                            word: pack_key(kb),
                            len: kb.len(),
                            schema_i,
                        });
                    } else {
                        long.push((key.clone(), schema_i));
                    }
                }
                d.object = Some(ObjectDispatch { words, long });
            }
            PlanNode::DiscUnion { map, .. } => {
                let mut compiled = DiscUnionDispatch::default();
                for (literal, id) in map {
                    match LiteralValue::from_json(literal) {
                        Some(k) => compiled.insert(k, *id),
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

    compute_optionality(&raw.nodes, &mut dispatch);

    Ok(CompiledPlan {
        raw,
        json_eligible: eligible,
        dispatch,
    })
}

/// Computes every node's `optin`/`optout` optionality, mirroring zod's
/// `_zod.optin`/`_zod.optout` flags: optional, default, prefault, and catch
/// schemas accept `undefined` input; nullable, lazy, and readonly wrappers
/// delegate to their inner type; unions and pipes aggregate across their
/// branches. Tuple validation reads these flags to place the optional tail.
fn compute_optionality(nodes: &[PlanNode], dispatch: &mut [NodeDispatch]) {
    let mut memo: Vec<Option<(bool, bool)>> = vec![None; nodes.len()];
    let mut visiting = vec![false; nodes.len()];
    for (id, d) in dispatch.iter_mut().enumerate() {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "arena indices are NodeId-valued by construction"
        )]
        let id = id as NodeId;
        let (optin, optout) = optionality(nodes, &mut memo, &mut visiting, id);
        d.optin_optional = optin;
        d.optout_optional = optout;
    }
}

fn optionality(
    nodes: &[PlanNode],
    memo: &mut [Option<(bool, bool)>],
    visiting: &mut [bool],
    id: NodeId,
) -> (bool, bool) {
    if let Some(done) = memo[id as usize] {
        return done;
    }
    // A cycle can only arise through a recursive lazy schema, whose
    // optionality is decided by the structural wrapper around it, so the
    // back-edge itself is treated as required.
    if visiting[id as usize] {
        return (false, false);
    }
    visiting[id as usize] = true;
    let flags = match &nodes[id as usize] {
        PlanNode::Optional { .. } => (true, true),
        PlanNode::Default { .. } | PlanNode::Prefault { .. } => (true, false),
        PlanNode::Catch { inner, .. } => (true, optionality(nodes, memo, visiting, *inner).1),
        PlanNode::Nullable { inner } | PlanNode::Lazy { inner } | PlanNode::Readonly { inner } => {
            optionality(nodes, memo, visiting, *inner)
        }
        PlanNode::Union { options } => {
            let mut flags = (false, false);
            for opt in options {
                let (optin, optout) = optionality(nodes, memo, visiting, *opt);
                flags.0 |= optin;
                flags.1 |= optout;
            }
            flags
        }
        PlanNode::Pipe { a, b } => (
            optionality(nodes, memo, visiting, *a).0,
            optionality(nodes, memo, visiting, *b).1,
        ),
        _ => (false, false),
    };
    visiting[id as usize] = false;
    memo[id as usize] = Some(flags);
    flags
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
