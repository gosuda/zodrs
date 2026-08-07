//! Validation: a `sonic-rs` DOM walked against the compiled plan arena in one
//! pass, tracking the single `dirty` flag that decides the verdict status.
//!
//! `dirty` is set by key stripping, applied defaults, `overwrite` transforms,
//! coercion, duplicate object keys collapsed to last-wins, and any object whose
//! retained input key order differed from its canonical schema key order. When
//! a valid parse stayed clean the input bytes are already canonical
//! (`status: 0`); when it went dirty the canonical output is rebuilt into
//! `payload` (`status: 1`). Invalid parses emit the raw issue array
//! (`status: 2`). A non-JSON-eligible plan — or input the SIMD parser rejects —
//! returns `status: 3`, telling the caller to fall back to the JS path (which
//! reproduces any `JSON.parse` `SyntaxError` exactly).

use std::borrow::Cow;
use std::collections::HashMap;

use serde_json::Value as Json;
use smallvec::{SmallVec, smallvec};
use sonic_rs::{JsonContainerTrait, JsonValueTrait, Object, Value};

use crate::compile::{CompiledCheck, CompiledPlan, NodeDispatch};
use crate::formats::FormatValidator;
use crate::issue::{Issue, Path, PathRef, PathSegRef, issues_to_json, issues_to_value};
use crate::plan::{BigIntFormat, Check, NodeId, NumberFormat, ObjectMode, OverwriteOp, PlanNode};

/// JavaScript's maximum safe integer, `2^53 - 1`.
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

/// Record entry count above which duplicate detection swaps the linear stack
/// probe for a hashed key index. Below it the probe is cheaper than hashing;
/// above it the quadratic term would dominate.
const RECORD_LINEAR_MAX: usize = 32;

/// The result of a byte-path validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// 0 = valid, input bytes are canonical; 1 = valid, `payload` is canonical
    /// output JSON; 2 = invalid, `payload` is the issue array JSON; 3 = plan
    /// not JSON-eligible or input unparseable — caller uses the JS path.
    pub status: u8,
    /// Canonical output JSON (status 1) or the issue array JSON (status 2).
    pub payload: Option<String>,
}

impl Verdict {
    fn fallback() -> Verdict {
        Verdict {
            status: 3,
            payload: None,
        }
    }
}

/// Validates raw JSON bytes against a compiled plan.
#[must_use]
pub fn validate(plan: &CompiledPlan, input: &[u8]) -> Verdict {
    if !plan.json_eligible {
        return Verdict::fallback();
    }
    // Hot path: single-pass byte validation. Only a provably clean-canonical
    // input short-circuits; everything else falls through to the DOM walk,
    // which owns rewrites, issues, and fallback semantics.
    if crate::scan::scan(plan, input) == crate::scan::Scan::Clean {
        return Verdict {
            status: 0,
            payload: None,
        };
    }
    let value: Value = match sonic_rs::from_slice(input) {
        Ok(v) => v,
        Err(_) => return Verdict::fallback(),
    };

    let mut v = Validator {
        plan,
        issues: Vec::new(),
        path: PathRef::new(),
        dirty: false,
        nonfinite: false,
        fail_count: 0,
        quiet: false,
    };
    v.check(plan.root(), &value);

    if !v.issues.is_empty() {
        return Verdict {
            status: 2,
            payload: Some(issues_to_json(&v.issues)),
        };
    }
    if !v.dirty {
        return Verdict {
            status: 0,
            payload: None,
        };
    }
    // The rewrite cannot represent a coerced `Infinity` (not JSON), and
    // sonic-rs normalizes every `-0` token to `0.0`, losing the sign that
    // `JSON.parse` would keep — defer both to the JS path.
    if v.nonfinite || contains_negative_zero(input) {
        return Verdict::fallback();
    }
    let mut out = String::new();
    write_output(plan, plan.root(), &value, &mut out);
    Verdict {
        status: 1,
        payload: Some(out),
    }
}

struct Validator<'p> {    plan: &'p CompiledPlan,
    issues: Vec<Issue>,
    /// Path stack of borrowed segments: schema keys are borrowed from the
    /// plan, indices are `Copy`; pushing costs no allocation.
    path: PathRef<'p>,
    dirty: bool,
    /// Set when a coercion produced a non-finite number: JSON cannot
    /// represent `Infinity` in the rewritten output, so the verdict must
    /// defer to the JS path (`status: 3`).
    nonfinite: bool,
    /// Monotonic count of every issue the walk would have emitted, including
    /// suppressed ones. Union branch probing detects failure from the delta
    /// without materializing the branch's issue list.
    fail_count: usize,
    /// When set, issue construction is suppressed (union dry-run probing).
    quiet: bool,
}

impl<'p> Validator<'p> {
    fn node(&self, id: NodeId) -> &'p PlanNode {
        &self.plan.nodes()[id as usize]
    }
    fn dispatch(&self, id: NodeId) -> &'p NodeDispatch {
        &self.plan.dispatch[id as usize]
    }

    fn push(&mut self, issue: Issue) {
        self.fail_count += 1;
        if !self.quiet {
            self.issues.push(issue);
        }
    }

    /// Emit the issue built by `build`, counting it even when suppressed.
    /// In `quiet` mode the closure never runs, so probing allocates nothing.
    fn emit(&mut self, build: impl FnOnce(&PathRef<'p>) -> Issue) {
        self.fail_count += 1;
        if !self.quiet {
            self.issues.push(build(&self.path));
        }
    }

    fn invalid_type(&mut self, expected: &str) {
        self.emit(|p| Issue::new("invalid_type", p).with("expected", Json::from(expected)));
    }
    fn invalid_value(&mut self, values: Vec<Json>) {
        self.emit(|p| Issue::new("invalid_value", p).with("values", Json::Array(values)));
    }

    /// Validate `value` against node `id`, appending issues on failure.
    #[allow(
        clippy::too_many_lines,
        clippy::match_same_arms,
        clippy::cast_precision_loss,
        reason = "one arm per plan-node kind reads clearer than a split; some distinct kinds share a no-op body; tuple lengths are small integers"
    )]
    fn check(&mut self, id: NodeId, value: &Value) {
        match self.node(id) {
            PlanNode::Any | PlanNode::Unknown => {}
            PlanNode::Never => self.invalid_type("never"),
            PlanNode::Null => {
                if !value.is_null() {
                    self.invalid_type("null");
                }
            }
            PlanNode::Undefined => self.invalid_type("undefined"),
            PlanNode::Void => self.invalid_type("void"),
            PlanNode::Nan => self.invalid_type("nan"),
            PlanNode::Symbol => self.invalid_type("symbol"),
            PlanNode::File { .. } => self.invalid_type("file"),
            PlanNode::Set { .. } => self.invalid_type("set"),
            PlanNode::Map { .. } => self.invalid_type("map"),

            PlanNode::Boolean { coerce } => {
                if !value.is_boolean() {
                    if *coerce {
                        self.dirty = true;
                    } else {
                        self.invalid_type("boolean");
                    }
                }
            }
            PlanNode::BigInt { coerce, .. } => {
                // A coerced bigint from a JSON number/string is accepted as-is.
                if !*coerce {
                    self.invalid_type("bigint");
                }
            }
            PlanNode::Date { coerce, .. } => {
                if !(*coerce && (value.is_str() || value.is_number())) {
                    self.invalid_type("date");
                }
            }

            PlanNode::String { coerce, .. } => self.check_string(id, value, *coerce),
            PlanNode::Number { coerce, .. } => self.check_number(id, value, *coerce),

            PlanNode::Literal { values } | PlanNode::Enum { values } => {
                if !values.iter().any(|lit| json_eq(value, lit)) {
                    let values = values.clone();
                    self.invalid_value(values);
                }
            }

            PlanNode::Object { .. } => self.check_object(id, value),
            PlanNode::Array { element, .. } => {
                let element = *element;
                let Some(arr) = value.as_array() else {
                    return self.invalid_type("array");
                };
                // Canonical order: element issues before length checks.
                for (i, elem) in arr.as_slice().iter().enumerate() {
                    self.path.push(idx(i));
                    self.check(element, elem);
                    self.path.pop();
                }
                self.array_checks(id, arr.len(), "array");
            }
            PlanNode::Tuple { items, rest } => {
                let rest = *rest;
                let Some(arr) = value.as_array() else {
                    return self.invalid_type("tuple");
                };
                let slice = arr.as_slice();
                // Canonical tuple length rules: without a rest schema a short
                // input reports only `too_small` (against the required-prefix
                // length, i.e. trailing optional-input items excluded) and
                // skips item validation entirely; a long input reports
                // `too_big` and still validates the in-range items.
                let optin_start = items.len()
                    - items
                        .iter()
                        .rev()
                        .take_while(|it| self.dispatch(**it).optin_optional)
                        .count();
                let optout_start = items.len()
                    - items
                        .iter()
                        .rev()
                        .take_while(|it| self.dispatch(**it).optout_optional)
                        .count();
                if rest.is_none() {
                    if slice.len() < optin_start {
                        self.emit(|p| {
                            Issue::new("too_small", p)
                                .with("origin", Json::from("array"))
                                .with("minimum", num_json(optin_start as f64))
                                .with("inclusive", Json::from(true))
                        });
                        return;
                    }
                    if slice.len() > items.len() {
                        self.emit(|p| {
                            Issue::new("too_big", p)
                                .with("origin", Json::from("array"))
                                .with("maximum", num_json(items.len() as f64))
                                .with("inclusive", Json::from(true))
                        });
                    }
                }
                for (i, item_id) in items.iter().enumerate() {
                    if let Some(elem) = slice.get(i) {
                        self.path.push(idx(i));
                        self.check(*item_id, elem);
                        self.path.pop();
                    } else {
                        // Absent slot: the item runs on `undefined`. A failing
                        // optional-tail item is swallowed (its slot and the
                        // remaining tail drop out of the output); a passing
                        // default/catch fills the slot, rewriting the input.
                        match absent_result(self.plan, *item_id) {
                            Absent::Fail => {
                                if i >= optout_start {
                                    break;
                                }
                                self.path.push(idx(i));
                                self.check_missing(*item_id);
                                self.path.pop();
                            }
                            Absent::Undefined => {}
                            Absent::Value(..) => self.dirty = true,
                        }
                    }
                }
                if let Some(rest_id) = rest {
                    for (i, elem) in slice.iter().enumerate().skip(items.len()) {
                        self.path.push(idx(i));
                        self.check(rest_id, elem);
                        self.path.pop();
                    }
                }
            }
            PlanNode::Union { options } => {
                self.check_union(options, value);
            }
            PlanNode::DiscUnion { key, .. } => {
                self.check_disc_union(id, key, value);
            }
            PlanNode::Intersection { left, right } => {
                let (left, right) = (*left, *right);
                self.check(left, value);
                self.check(right, value);
            }
            PlanNode::Record { key, value: val } => {
                let (key_id, val_id) = (*key, *val);
                let Some(obj) = value.as_object() else {
                    // z.record rejects non-objects (arrays included) as `record`.
                    return self.invalid_type("record");
                };
                // Collapse duplicates to last-wins, keeping the first
                // position. Small records stay on the stack behind a linear
                // probe; past `RECORD_LINEAR_MAX` a key index takes over, so a
                // large map costs O(n) instead of O(n^2).
                let mut entries: SmallVec<[(&str, &Value); 16]> = SmallVec::new();
                let mut index: Option<HashMap<&str, usize>> = None;
                let mut collapsed = false;
                for (k, v) in obj {
                    let seen = match &index {
                        Some(ix) => ix.get(k).copied(),
                        None => entries.iter().position(|(ek, _)| *ek == k),
                    };
                    if let Some(i) = seen {
                        entries[i].1 = v;
                        collapsed = true;
                        continue;
                    }
                    if let Some(ix) = &mut index {
                        ix.insert(k, entries.len());
                    } else if entries.len() == RECORD_LINEAR_MAX {
                        let mut ix: HashMap<&str, usize> =
                            HashMap::with_capacity(entries.len() * 2);
                        ix.extend(entries.iter().enumerate().map(|(i, (ek, _))| (*ek, i)));
                        ix.insert(k, entries.len());
                        index = Some(ix);
                    }
                    entries.push((k, v));
                }
                if collapsed {
                    self.dirty = true;
                }
                let string_key = matches!(self.node(key_id), PlanNode::String { .. });
                for (k, entry) in entries {
                    // Canonical records skip `__proto__` keys entirely: never
                    // validated, never retained (the TS output builder's
                    // plain-object assignment would target the prototype).
                    // Dropping the key rewrites the input.
                    if k == "__proto__" {
                        self.dirty = true;
                        continue;
                    }
                    // Record key validation (invalid_key on failure). A string
                    // key schema validates the key text directly; any other
                    // key schema round-trips through a parsed JSON string.
                    let before_i = self.issues.len();
                    let before_f = self.fail_count;
                    let saved = std::mem::take(&mut self.path);
                    if string_key {
                        self.string_checks(key_id, Cow::Borrowed(k));
                    } else {
                        let key_val: Value =
                            sonic_rs::from_str(&json_string(k)).unwrap_or_default();
                        self.check(key_id, &key_val);
                    }
                    self.path = saved;
                    if self.fail_count != before_f && !self.quiet {
                        let key_issues = self.issues.split_off(before_i);
                        self.push(
                            Issue::new("invalid_key", &self.path)
                                .with("origin", Json::from("record"))
                                .with("issues", issues_to_value(&key_issues)),
                        );
                    }
                    self.path.push(PathSegRef::Key(Cow::Owned(k.to_string())));
                    self.check(val_id, entry);
                    self.path.pop();
                }
            }

            PlanNode::Optional { inner }
            | PlanNode::NonOptional { inner }
            | PlanNode::Readonly { inner }
            | PlanNode::Lazy { inner }
            | PlanNode::Promise { inner }
            | PlanNode::Default { inner, .. }
            | PlanNode::Prefault { inner, .. } => {
                let inner = *inner;
                self.check(inner, value);
            }
            PlanNode::Nullable { inner } => {
                if !value.is_null() {
                    let inner = *inner;
                    self.check(inner, value);
                }
            }
            PlanNode::Catch { inner, .. } => {
                let inner = *inner;
                let before_i = self.issues.len();
                let before_f = self.fail_count;
                self.check(inner, value);
                if self.fail_count != before_f {
                    self.issues.truncate(before_i);
                    self.fail_count = before_f;
                    self.dirty = true; // catch value replaces the input
                }
            }
            PlanNode::Pipe { a, b } => {
                let (a, b) = (*a, *b);
                let before = self.fail_count;
                self.check(a, value);
                if self.fail_count == before {
                    self.check(b, value);
                }
            }
            PlanNode::TemplateLiteral { .. } => {
                let Some(s) = value.as_str() else {
                    return self.invalid_type("string");
                };
                if let Some(re) = &self.dispatch(id).template
                    && !re.is_match(s)
                {
                    self.emit(|p| {
                        Issue::new("invalid_format", p)
                            .with("origin", Json::from("string"))
                            .with("format", Json::from("template_literal"))
                    });
                }
            }
            PlanNode::Host { .. } => {} // unreachable: host poisons eligibility
        }
    }

    /// Emit the issue a node produces for a missing (JS `undefined`) input, per
    /// canonical zod semantics: `invalid_type` for most kinds, `invalid_value`
    /// for literal/enum, and a recursive `invalid_union` for unions. Nodes that
    /// accept absence (optional / any / unknown / void / default-bearing) emit
    /// nothing.
    fn check_missing(&mut self, id: NodeId) {
        match self.node(id) {
            PlanNode::Optional { .. }
            | PlanNode::Any
            | PlanNode::Unknown
            | PlanNode::Void
            | PlanNode::Undefined
            | PlanNode::Default { .. }
            | PlanNode::Prefault { .. }
            | PlanNode::Catch { .. }
            | PlanNode::Host { .. } => {}
            PlanNode::String { .. } | PlanNode::TemplateLiteral { .. } => {
                self.invalid_type("string");
            }
            PlanNode::Number { .. } => self.invalid_type("number"),
            PlanNode::Boolean { .. } => self.invalid_type("boolean"),
            PlanNode::BigInt { .. } => self.invalid_type("bigint"),
            PlanNode::Date { .. } => self.invalid_type("date"),
            PlanNode::Symbol => self.invalid_type("symbol"),
            PlanNode::File { .. } => self.invalid_type("file"),
            PlanNode::Null => self.invalid_type("null"),
            PlanNode::Nan => self.invalid_type("nan"),
            PlanNode::Never => self.invalid_type("never"),
            PlanNode::Object { .. } | PlanNode::DiscUnion { .. } => self.invalid_type("object"),
            PlanNode::Record { .. } => self.invalid_type("record"),
            PlanNode::Array { .. } => self.invalid_type("array"),
            PlanNode::Tuple { .. } => self.invalid_type("tuple"),
            PlanNode::Map { .. } => self.invalid_type("map"),
            PlanNode::Set { .. } => self.invalid_type("set"),
            PlanNode::NonOptional { .. } => self.invalid_type("nonoptional"),
            PlanNode::Literal { values } | PlanNode::Enum { values } => {
                let values = values.clone();
                self.invalid_value(values);
            }
            PlanNode::Nullable { inner }
            | PlanNode::Readonly { inner }
            | PlanNode::Lazy { inner }
            | PlanNode::Promise { inner } => {
                let inner = *inner;
                self.check_missing(inner);
            }
            PlanNode::Pipe { a, .. } => {
                let a = *a;
                self.check_missing(a);
            }
            PlanNode::Intersection { left, right } => {
                let (left, right) = (*left, *right);
                self.check_missing(left);
                self.check_missing(right);
            }
            PlanNode::Union { options } => {
                let union_path = self.path.clone();
                let mut branch_errors: Vec<Json> = Vec::new();
                for opt in options {
                    let before_f = self.fail_count;
                    let before_i = self.issues.len();
                    self.path = PathRef::new();
                    self.check_missing(*opt);
                    self.path.clone_from(&union_path);
                    if self.fail_count == before_f {
                        return; // an option accepts undefined
                    }
                    if !self.quiet {
                        let branch = self.issues.split_off(before_i);
                        branch_errors.push(issues_to_value(&branch));
                    }
                }
                self.emit(|p| {
                    Issue::new("invalid_union", p).with("errors", Json::Array(branch_errors))
                });
            }
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "length bounds are small, non-negative integers"
    )]
    fn check_string(&mut self, id: NodeId, value: &Value, coerce: bool) {
        let cur: Cow<'_, str> = if let Some(s) = value.as_str() {
            Cow::Borrowed(s)
        } else if coerce && (value.is_number() || value.is_boolean()) {
            self.dirty = true;
            Cow::Owned(coerce_to_string(value))
        } else {
            return self.invalid_type("string");
        };
        self.string_checks(id, cur);
    }

    /// Runs a string node's checks against `cur`, allocating only when an
    /// `overwrite` check actually rewrites the text.
    #[allow(
        clippy::too_many_lines,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "one arm per string check reads clearer than a split; length bounds are small, non-negative integers"
    )]
    fn string_checks(&mut self, id: NodeId, mut cur: Cow<'_, str>) {
        let PlanNode::String { checks, .. } = self.node(id) else {
            return;
        };
        let compiled = &self.dispatch(id).checks;
        for (ci, check) in checks.iter().enumerate() {
            match check {
                Check::MinLength { v } => {
                    if utf16_len(&cur) < *v as usize {
                        self.too_small("string", *v, true, false);
                    }
                }
                Check::MaxLength { v } => {
                    if utf16_len(&cur) > *v as usize {
                        self.too_big("string", *v, true, false);
                    }
                }
                Check::Length { v } => {
                    let len = utf16_len(&cur) as f64;
                    if len < *v {
                        self.too_small("string", *v, true, true);
                    } else if len > *v {
                        self.too_big("string", *v, true, true);
                    }
                }
                Check::StartsWith { v } => {
                    if !cur.starts_with(v) {
                        self.string_format("starts_with", "prefix", v);
                    }
                }
                Check::EndsWith { v } => {
                    if !cur.ends_with(v) {
                        self.string_format("ends_with", "suffix", v);
                    }
                }
                Check::Includes { v, position } => {
                    let found = match position {
                        Some(p) => cur.get(*p..).is_some_and(|tail| tail.contains(v)),
                        None => cur.contains(v),
                    };
                    if !found {
                        self.string_format("includes", "includes", v);
                    }
                }
                Check::Lowercase => {
                    if cur.chars().any(char::is_uppercase) {
                        self.string_format("lowercase", "pattern", "/^[^A-Z]*$/");
                    }
                }
                Check::Uppercase => {
                    if cur.chars().any(char::is_lowercase) {
                        self.string_format("uppercase", "pattern", "/^[^a-z]*$/");
                    }
                }
                Check::Regex { src, flags } => {
                    if let Some(Some(CompiledCheck::Regex(re))) = compiled.get(ci)
                        && !re.is_match(&cur)
                    {
                        // Canonical regex issue carries `origin: "string"`
                        // alongside the JS pattern source, which the message
                        // interpolates (zod v4 `$ZodIssueInvalidStringFormat`).
                        self.emit(|p| {
                            Issue::new_check("invalid_format", p)
                                .with("origin", Json::from("string"))
                                .with("format", Json::from("regex"))
                                .with("pattern", Json::from(format!("/{src}/{flags}")))
                        });
                    }
                }
                Check::Format { .. } => {
                    if let Some(Some(CompiledCheck::Format(f))) = compiled.get(ci)
                        && !f.is_valid(&cur)
                    {
                        self.format_issue(f);
                    }
                }
                Check::Overwrite { op, form } => {
                    let next = apply_overwrite(&cur, *op, form.as_deref());
                    if next.as_str() != cur.as_ref() {
                        self.dirty = true;
                        cur = Cow::Owned(next);
                    }
                }
                _ => {}
            }
        }
    }

    fn check_number(&mut self, id: NodeId, value: &Value, coerce: bool) {
        let n: f64;
        if let Some(f) = number_of(value) {
            n = f;
        } else if coerce {
            match coerce_to_number(value) {
                Some(f) => {
                    // JS Number() yielding NaN fails z.number() as
                    // invalid_type; Infinity validates but cannot be written
                    // back as JSON, so the verdict defers to the JS path.
                    if f.is_nan() {
                        return self.invalid_type("number");
                    }
                    if !f.is_finite() {
                        self.nonfinite = true;
                    }
                    n = f;
                    self.dirty = true;
                }
                None => return self.invalid_type("number"),
            }
        } else {
            return self.invalid_type("number");
        }

        let PlanNode::Number { checks, .. } = self.node(id) else {
            return;
        };
        for check in checks {
            match check {
                Check::Gt { v, inclusive, .. } => {
                    let bound = v.as_f64().unwrap_or(f64::NEG_INFINITY);
                    let ok = if *inclusive { n >= bound } else { n > bound };
                    if !ok {
                        self.too_small("number", bound, *inclusive, false);
                    }
                }
                Check::Lt { v, inclusive, .. } => {
                    let bound = v.as_f64().unwrap_or(f64::INFINITY);
                    let ok = if *inclusive { n <= bound } else { n < bound };
                    if !ok {
                        self.too_big("number", bound, *inclusive, false);
                    }
                }
                Check::MultipleOf { v } => {
                    let d = v.as_f64().unwrap_or(1.0);
                    if !float_multiple_of(n, d) {
                        self.emit(|p| {
                            Issue::new_check("not_multiple_of", p)
                                .with("origin", Json::from("number"))
                                .with("divisor", num_json(d))
                        });
                    }
                }
                Check::NumberFormat { v } => self.number_format(*v, n),
                Check::BigIntFormat { v } => self.bigint_format(*v, n),
                _ => {}
            }
        }
    }

    fn number_format(&mut self, fmt: NumberFormat, n: f64) {
        let is_int = matches!(
            fmt,
            NumberFormat::Int32 | NumberFormat::Uint32 | NumberFormat::Safeint
        );
        if is_int {
            if n.fract() != 0.0 || !n.is_finite() {
                self.emit(|p| {
                    Issue::new_check("invalid_type", p)
                        .with("expected", Json::from("int"))
                        .with("format", Json::from(number_format_id(fmt)))
                });
                return;
            }
            if n.abs() > MAX_SAFE_INT {
                if n > 0.0 {
                    self.emit(|p| {
                        Issue::new_check("too_big", p)
                            .with("origin", Json::from("int"))
                            .with("maximum", num_json(MAX_SAFE_INT))
                            .with("inclusive", Json::from(true))
                            .with(
                                "note",
                                Json::from("Integers must be within the safe integer range."),
                            )
                    });
                } else {
                    self.emit(|p| {
                        Issue::new_check("too_small", p)
                            .with("origin", Json::from("int"))
                            .with("minimum", num_json(-MAX_SAFE_INT))
                            .with("inclusive", Json::from(true))
                            .with(
                                "note",
                                Json::from("Integers must be within the safe integer range."),
                            )
                    });
                }
                return;
            }
        }
        let (min, max) = number_format_range(fmt);
        if n < min {
            self.emit(|p| {
                Issue::new_check("too_small", p)
                    .with("origin", Json::from("number"))
                    .with("minimum", num_json(min))
                    .with("inclusive", Json::from(true))
            });
        }
        if n > max {
            self.emit(|p| {
                Issue::new_check("too_big", p)
                    .with("origin", Json::from("number"))
                    .with("maximum", num_json(max))
                    .with("inclusive", Json::from(true))
            });
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "f64->i128 is exact for every integral f64; the bound back-cast only feeds the issue payload, which zod reports at the same f64 precision"
    )]
    fn bigint_format(&mut self, fmt: BigIntFormat, n: f64) {
        // `n` is the f64 the JSON parser produced — exactly what `BigInt(v)`
        // sees in JS — so compare in integer space the way zod does against
        // `util.BIGINT_FORMAT_RANGES`. An f64 bound literal cannot: `i64::MAX`
        // and `2^63` collapse onto one f64, so `n <= max` in f64 would accept
        // the overflowing `2^63` that zod rejects.
        let (min, max): (i128, i128) = match fmt {
            BigIntFormat::Int64 => (i64::MIN.into(), i64::MAX.into()),
            BigIntFormat::Uint64 => (0, u64::MAX.into()),
        };
        let exact = n as i128;
        if exact < min {
            self.too_small("bigint", min as f64, true, false);
        }
        if exact > max {
            self.too_big("bigint", max as f64, true, false);
        }
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "collection lengths compared against small numeric bounds"
    )]
    fn array_checks(&mut self, id: NodeId, len: usize, origin: &str) {
        let PlanNode::Array { checks, .. } = self.node(id) else {
            return;
        };
        let len_f = len as f64;
        for check in checks {
            match check {
                Check::MinLength { v } | Check::MinSize { v } => {
                    if len_f < *v {
                        self.too_small(origin, *v, true, false);
                    }
                }
                Check::MaxLength { v } | Check::MaxSize { v } => {
                    if len_f > *v {
                        self.too_big(origin, *v, true, false);
                    }
                }
                Check::Length { v } | Check::Size { v } => {
                    if len_f < *v {
                        self.too_small(origin, *v, true, true);
                    } else if len_f > *v {
                        self.too_big(origin, *v, true, true);
                    }
                }
                _ => {}
            }
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "object field counts fit in u32 by arena construction"
    )]
    fn check_object(&mut self, id: NodeId, value: &Value) {
        let PlanNode::Object {
            keys,
            values,
            mode,
            catchall,
            ..
        } = self.node(id)
        else {
            return;
        };
        let mode = *mode;
        let catchall = *catchall;
        let obj_dispatch = &self.dispatch(id).object;

        let Some(obj) = value.as_object() else {
            return self.invalid_type("object");
        };

        // One pass over the input entries, on the stack: match each key
        // against the sorted schema index (memchr first-byte screen, then
        // binary search), collapsing duplicates to ECMA-262 last-wins with
        // the first position kept. Any collapse means the input bytes are
        // not canonical.
        let mut pos: SmallVec<[u32; 16]> = smallvec![u32::MAX; keys.len()];
        let mut known: SmallVec<[(u32, &Value); 16]> = SmallVec::new();
        let mut unknowns: SmallVec<[(&str, &Value); 8]> = SmallVec::new();
        let mut collapsed = false;
        for (k, v) in obj {
            if let Some(schema_i) = obj_dispatch.as_ref().and_then(|o| o.find(k)) {
                let slot = &mut pos[schema_i];
                if *slot == u32::MAX {
                    *slot = known.len() as u32;
                    known.push((schema_i as u32, v));
                } else {
                    known[*slot as usize].1 = v;
                    collapsed = true;
                }
            } else if k == "__proto__" {
                // Canonical skips __proto__ in unknown-key handling entirely:
                // never flagged, never retained. Dropping it rewrites the input.
                self.dirty = true;
            } else if let Some(slot) = unknowns.iter_mut().find(|(ek, _)| *ek == k) {
                slot.1 = v;
                collapsed = true;
            } else {
                unknowns.push((k, v));
            }
        }
        if collapsed {
            self.dirty = true;
        }

        // Retained known keys not in ascending schema order => reorder => dirty.
        if known.windows(2).any(|w| w[0].0 > w[1].0) {
            self.dirty = true;
        }

        // Canonical issue order: every shape key in schema order — present
        // values are validated, absent ones apply a default or emit the
        // missing-input issue.
        for (schema_i, key) in keys.iter().enumerate() {
            let slot = pos[schema_i];
            if slot != u32::MAX {
                let child = known[slot as usize].1;
                self.path.push(PathSegRef::Key(Cow::Borrowed(key.as_str())));
                self.check(values[schema_i], child);
                self.path.pop();
            } else if has_default(self.plan, values[schema_i]) {
                self.dirty = true;
            } else {
                self.path.push(PathSegRef::Key(Cow::Borrowed(key.as_str())));
                self.check_missing(values[schema_i]);
                self.path.pop();
            }
        }

        // Then unknown keys in input order: a catchall validates them, strict
        // mode rejects them, and strip/passthrough rewrites the output (strip
        // drops the key; passthrough appends it after the schema keys).
        if let Some(catchall_id) = catchall {
            for (k, v) in &unknowns {
                self.path.push(PathSegRef::Key(Cow::Owned(k.to_string())));
                self.check(catchall_id, v);
                self.path.pop();
            }
        } else if !unknowns.is_empty() {
            match mode {
                ObjectMode::Strip | ObjectMode::Passthrough => self.dirty = true,
                ObjectMode::Strict => {
                    self.emit(|p| {
                        Issue::new("unrecognized_keys", p).with(
                            "keys",
                            Json::Array(unknowns.iter().map(|(k, _)| Json::from(*k)).collect()),
                        )
                    });
                }
            }
        }
    }

    fn check_union(&mut self, options: &[NodeId], value: &Value) {
        let saved_quiet = self.quiet;
        let union_path = self.path.clone();
        let union_dirty = self.dirty;
        let entry_fails = self.fail_count;
        // Dry-run pass: the first passing option wins. Failures are detected
        // from the fail counter with issue construction suppressed, so an
        // option that does not match costs no allocation.
        for opt in options {
            self.quiet = true;
            self.check(*opt, value);
            self.quiet = saved_quiet;
            if self.fail_count == entry_fails {
                return; // first successful option wins
            }
            // A failed option may still have probed (and abandoned) branches
            // of its own nested unions; erase those suppressed probes so the
            // next option is measured from a clean baseline.
            self.fail_count = entry_fails;
            self.dirty = union_dirty;
        }
        // Every option failed: re-run with issue collection to build the
        // canonical branch errors. Sub-issues keep paths relative to the
        // option: reset the path before checking each branch so it doesn't
        // inherit the union's path prefix. The wrapper invalid_union carries
        // the union path.
        let mut branch_issues: Vec<Vec<Issue>> = Vec::new();
        for opt in options {
            let before = self.issues.len();
            self.path = PathRef::new();
            self.check(*opt, value);
            self.path.clone_from(&union_path);
            let branch = self.issues.split_off(before);
            branch_issues.push(branch);
            self.dirty = union_dirty;
        }
        // Canonical flattening: when exactly one branch is "nonaborted"
        // (all its issues have `aborting == false`, mirroring TS
        // `continue === true` from `checkPayloadIssues()`), surface that
        // branch's issues directly with the union path prepended.
        let nonaborted_indices: Vec<usize> = branch_issues
            .iter()
            .enumerate()
            .filter(|(_, issues)| issues.iter().all(|iss| !iss.aborting))
            .map(|(i, _)| i)
            .collect();
        if let [idx] = nonaborted_indices.as_slice() {
            let idx = *idx;
            if let Some(issues) = branch_issues.get(idx) {
                for iss in issues {
                    let mut new_issue = iss.clone();
                    let mut full_path: Path =
                        union_path.iter().map(PathSegRef::to_owned_seg).collect();
                    full_path.extend(iss.path.iter().cloned());
                    new_issue.path = full_path;
                    self.push(new_issue);
                }
                return;
            }
        }
        let branch_errors: Vec<Json> =
            branch_issues.iter().map(|issues| issues_to_value(issues)).collect();
        self.push(
            Issue::new("invalid_union", &union_path)
                .with("errors", Json::Array(branch_errors)),
        );
    }

    fn check_disc_union(&mut self, id: NodeId, disc_key: &'p str, value: &Value) {
        let Some(obj) = value.as_object() else {
            return self.invalid_type("object");
        };
        // Last-wins value of the discriminant key, scanned without collapse.
        let mut disc: Option<&Value> = None;
        for (k, v) in obj {
            if k == disc_key {
                disc = Some(v);
            }
        }
        let target = disc.and_then(|v| {
            self.dispatch(id)
                .disc_union
                .as_ref()
                .and_then(|d| d.find_value(v))
        });
        if let Some(node) = target {
            return self.check(node, value);
        }

        // No matching discriminator: canonical invalid_union carrying the
        // discriminator name, the expected option values, and the disc-key path.
        let options: Vec<Json> = match self.node(id) {
            PlanNode::DiscUnion { map, .. } => map.iter().map(|(v, _)| v.clone()).collect(),
            _ => Vec::new(),
        };
        self.path.push(PathSegRef::Key(Cow::Borrowed(disc_key)));
        self.emit(|p| {
            Issue::new("invalid_union", p)
                .with("errors", Json::Array(Vec::new()))
                .with("note", Json::from("No matching discriminator"))
                .with("discriminator", Json::from(disc_key))
                .with("options", Json::Array(options))
        });
        self.path.pop();
    }

    // ---- issue helpers -------------------------------------------------

    fn too_small(&mut self, origin: &str, minimum: f64, inclusive: bool, exact: bool) {
        self.emit(|p| {
            let mut issue = Issue::new_check("too_small", p)
                .with("origin", Json::from(origin))
                .with("minimum", num_json(minimum))
                .with("inclusive", Json::from(inclusive));
            if exact {
                issue = issue.with("exact", Json::from(true));
            }
            issue
        });
    }
    fn too_big(&mut self, origin: &str, maximum: f64, inclusive: bool, exact: bool) {
        self.emit(|p| {
            let mut issue = Issue::new_check("too_big", p)
                .with("origin", Json::from(origin))
                .with("maximum", num_json(maximum))
                .with("inclusive", Json::from(inclusive));
            if exact {
                issue = issue.with("exact", Json::from(true));
            }
            issue
        });
    }
    fn string_format(&mut self, format: &'static str, key: &'static str, value: &str) {
        self.emit(|p| {
            Issue::new_check("invalid_format", p)
                .with("origin", Json::from("string"))
                .with("format", Json::from(format))
                .with(key, Json::from(value))
        });
    }
    fn format_issue(&mut self, f: &FormatValidator) {
        self.emit(|p| {
            if let Some(pat) = &f.pattern {
                Issue::new_check("invalid_format", p)
                    .with("origin", Json::from("string"))
                    .with("format", Json::from(f.id.clone()))
                    .with("pattern", Json::from(pat.clone()))
            } else {
                Issue::new_check("invalid_format", p)
                    .with("format", Json::from(f.id.clone()))
            }
        });
    }
}

// ------------------------------------------------------------------------
// Canonical output emission (only when a valid parse went dirty).
// ------------------------------------------------------------------------

#[allow(
    clippy::too_many_lines,
    reason = "one arm per plan-node kind reads clearer than a split"
)]
fn write_output(plan: &CompiledPlan, id: NodeId, value: &Value, out: &mut String) {
    match &plan.nodes()[id as usize] {
        PlanNode::Object {
            keys,
            values,
            mode,
            catchall,
            ..
        } => {
            let Some(obj) = value.as_object() else {
                return append_raw(value, out);
            };
            let entries = collapse_object(obj);
            let mut lookup: HashMap<&str, &Value> = HashMap::with_capacity(entries.len());
            for (k, v) in &entries {
                lookup.insert(k, v);
            }
            out.push('{');
            let mut first = true;
            let disp = plan.dispatch[id as usize].object.as_ref();
            // Canonical schema key order.
            for (schema_i, key) in keys.iter().enumerate() {
                if let Some(child) = lookup.get(key.as_str()) {
                    write_pair(key, out, &mut first);
                    write_output(plan, values[schema_i], child, out);
                } else if let Some(def) = default_value(plan, values[schema_i]) {
                    write_pair(key, out, &mut first);
                    out.push_str(&serde_json::to_string(&def).unwrap_or_else(|_| "null".into()));
                }
            }
            // Retained unknowns (passthrough / catchall), __proto__ excluded.
            if *mode == ObjectMode::Passthrough || catchall.is_some() {
                for (k, v) in &entries {
                    if *k == "__proto__" {
                        continue;
                    }
                    let known = disp.and_then(|o| o.find(k)).is_some();
                    if !known {
                        write_pair(k, out, &mut first);
                        if let Some(ca) = catchall {
                            write_output(plan, *ca, v, out);
                        } else {
                            append_raw(v, out);
                        }
                    }
                }
            }
            out.push('}');
        }
        PlanNode::Array { element, .. } => {
            let Some(arr) = value.as_array() else {
                return append_raw(value, out);
            };
            out.push('[');
            for (i, elem) in arr.as_slice().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_output(plan, *element, elem, out);
            }
            out.push(']');
        }
        PlanNode::Tuple { items, rest } => {
            let Some(arr) = value.as_array() else {
                return append_raw(value, out);
            };
            let slice = arr.as_slice();
            // Build the slot list first: absent items contribute their
            // default/catch value or an `undefined` slot, and the canonical
            // trailing truncation then drops trailing absent optional-output
            // slots (the array analog of an absent optional object key).
            let mut slots: Vec<Option<String>> = Vec::with_capacity(items.len().max(slice.len()));
            for (i, item_id) in items.iter().enumerate() {
                if let Some(elem) = slice.get(i) {
                    let mut s = String::new();
                    write_output(plan, *item_id, elem, &mut s);
                    slots.push(Some(s));
                } else {
                    match absent_result(plan, *item_id) {
                        // Swallowed by the optional-tail rule (a non-swallowed
                        // failure never reaches output construction).
                        Absent::Fail => break,
                        Absent::Undefined => slots.push(None),
                        Absent::Value(v, _) => slots.push(Some(
                            serde_json::to_string(&v).unwrap_or_else(|_| "null".into()),
                        )),
                    }
                }
            }
            if let Some(rest_id) = rest {
                for elem in slice.iter().skip(items.len()) {
                    let mut s = String::new();
                    write_output(plan, *rest_id, elem, &mut s);
                    slots.push(Some(s));
                }
            }
            while slots.len() > slice.len() {
                let last = slots.len() - 1;
                if last < items.len()
                    && plan.dispatch[items[last] as usize].optout_optional
                    && slots[last].is_none()
                {
                    slots.pop();
                } else {
                    break;
                }
            }
            out.push('[');
            for (i, slot) in slots.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                match slot {
                    Some(s) => out.push_str(s),
                    None => out.push_str("null"),
                }
            }
            out.push(']');
        }
        PlanNode::Record { value: val, .. } => {
            let Some(obj) = value.as_object() else {
                return append_raw(value, out);
            };
            out.push('{');
            let mut first = true;
            for (k, v) in collapse_object(obj) {
                if k == "__proto__" {
                    continue; // records never retain __proto__ (see check)
                }
                write_pair(k, out, &mut first);
                write_output(plan, *val, v, out);
            }
            out.push('}');
        }
        PlanNode::String { checks, coerce } => {
            let mut cur = if let Some(s) = value.as_str() {
                s.to_string()
            } else if *coerce {
                coerce_to_string(value)
            } else {
                return append_raw(value, out);
            };
            for check in checks {
                if let Check::Overwrite { op, form } = check {
                    cur = apply_overwrite(&cur, *op, form.as_deref());
                }
            }
            out.push_str(&json_string(&cur));
        }
        PlanNode::Number { coerce, .. } => {
            if value.is_number() {
                append_raw(value, out);
            } else if *coerce {
                match coerce_to_number(value) {
                    Some(f) => out.push_str(&num_json(f).to_string()),
                    None => append_raw(value, out),
                }
            } else {
                append_raw(value, out);
            }
        }
        PlanNode::Catch {
            inner,
            value: catch_val,
            ..
        } => {
            // Emit the caught fallback only when the inner schema would fail.
            if option_matches(plan, *inner, value) {
                write_output(plan, *inner, value, out);
            } else {
                out.push_str(&serde_json::to_string(catch_val).unwrap_or_else(|_| "null".into()));
            }
        }
        PlanNode::Optional { inner }
        | PlanNode::NonOptional { inner }
        | PlanNode::Readonly { inner }
        | PlanNode::Lazy { inner }
        | PlanNode::Promise { inner }
        | PlanNode::Default { inner, .. }
        | PlanNode::Prefault { inner, .. } => {
            if value.is_null() {
                append_raw(value, out);
            } else {
                write_output(plan, *inner, value, out);
            }
        }
        PlanNode::Nullable { inner } => {
            if value.is_null() {
                out.push_str("null");
            } else {
                write_output(plan, *inner, value, out);
            }
        }
        PlanNode::Pipe { a, .. } => write_output(plan, *a, value, out),
        PlanNode::Intersection { left, .. } => write_output(plan, *left, value, out),
        PlanNode::Union { options } => {
            // Re-select the first passing option for output.
            for opt in options {
                if option_matches(plan, *opt, value) {
                    return write_output(plan, *opt, value, out);
                }
            }
            append_raw(value, out);
        }
        PlanNode::DiscUnion { key, .. } => {
            let target = value
                .as_object()
                .and_then(|o| {
                    let mut disc: Option<&Value> = None;
                    for (k, v) in o {
                        if k == key {
                            disc = Some(v);
                        }
                    }
                    disc
                })
                .and_then(|v| {
                    plan.dispatch[id as usize]
                        .disc_union
                        .as_ref()
                        .and_then(|d| d.find_value(v))
                });
            match target {
                Some(node) => write_output(plan, node, value, out),
                None => append_raw(value, out),
            }
        }
        _ => append_raw(value, out),
    }
}

fn option_matches(plan: &CompiledPlan, id: NodeId, value: &Value) -> bool {
    let mut v = Validator {
        plan,
        issues: Vec::new(),
        path: PathRef::new(),
        dirty: false,
        nonfinite: false,
        fail_count: 0,
        quiet: false,
    };
    v.check(id, value);
    v.issues.is_empty()
}

/// The outcome of running a schema on `undefined` (a missing tuple slot).
enum Absent {
    /// Validates cleanly with `undefined` output (the slot drops out of the
    /// tuple output).
    Undefined,
    /// Validates cleanly with a concrete JSON value (defaults, catches). The
    /// flag marks a catch fallback: canonical `handleOptionalResult` swallows
    /// it back to `undefined` under an `Optional` wrapper.
    Value(Json, bool),
    /// Emits issues on `undefined` input.
    Fail,
}

fn absent_result(plan: &CompiledPlan, id: NodeId) -> Absent {
    match &plan.nodes()[id as usize] {
        PlanNode::Any | PlanNode::Unknown | PlanNode::Undefined | PlanNode::Void => {
            Absent::Undefined
        }
        PlanNode::Optional { inner } => {
            if plan.dispatch[*inner as usize].optin_optional {
                match absent_result(plan, *inner) {
                    // `handleOptionalResult`: undefined input plus issues or a
                    // catch fallback resolves to a clean `undefined`.
                    Absent::Fail | Absent::Value(_, true) => Absent::Undefined,
                    ok => ok,
                }
            } else {
                Absent::Undefined
            }
        }
        PlanNode::Default { value, .. } | PlanNode::Prefault { value, .. } => {
            Absent::Value(value.clone(), false)
        }
        PlanNode::Catch { inner, value, .. } => match absent_result(plan, *inner) {
            Absent::Fail => Absent::Value(value.clone(), true),
            ok => ok,
        },
        PlanNode::Union { options } => {
            for opt in options {
                match absent_result(plan, *opt) {
                    Absent::Fail => {}
                    ok => return ok,
                }
            }
            Absent::Fail
        }
        PlanNode::Pipe { a, b } => match absent_result(plan, *a) {
            Absent::Fail => Absent::Fail,
            Absent::Undefined => absent_result(plan, *b),
            Absent::Value(va, fell_back) => match run_concrete(plan, *b, &va) {
                Some(vb) => Absent::Value(vb, fell_back),
                None => Absent::Fail,
            },
        },
        PlanNode::Nullable { inner } | PlanNode::Lazy { inner } | PlanNode::Readonly { inner } => {
            absent_result(plan, *inner)
        }
        PlanNode::Intersection { left, right } => {
            match (absent_result(plan, *left), absent_result(plan, *right)) {
                (Absent::Fail, _) | (_, Absent::Fail) => Absent::Fail,
                (Absent::Undefined, Absent::Undefined) => Absent::Undefined,
                (Absent::Value(v, f), Absent::Undefined)
                | (Absent::Undefined, Absent::Value(v, f)) => Absent::Value(v, f),
                (Absent::Value(a, fa), Absent::Value(b, fb)) => {
                    match (a, b) {
                        (Json::Object(mut x), Json::Object(y)) => {
                            x.extend(y);
                            Absent::Value(Json::Object(x), fa || fb)
                        }
                        // Non-mergeable undefined intersections do not arise
                        // in JSON-eligible schemas; treat as failure.
                        _ => Absent::Fail,
                    }
                }
            }
        }
        _ => Absent::Fail,
    }
}

/// Runs a schema on an already-parsed JSON value, returning its output.
fn run_concrete(plan: &CompiledPlan, id: NodeId, v: &Json) -> Option<Json> {
    let text = serde_json::to_string(v).ok()?;
    let value: Value = sonic_rs::from_str(&text).ok()?;
    if !option_matches(plan, id, &value) {
        return None;
    }
    let mut s = String::new();
    write_output(plan, id, &value, &mut s);
    serde_json::from_str(&s).ok()
}

fn default_value(plan: &CompiledPlan, id: NodeId) -> Option<Json> {
    match &plan.nodes()[id as usize] {
        PlanNode::Default { value, .. }
        | PlanNode::Prefault { value, .. }
        | PlanNode::Catch { value, .. } => Some(value.clone()),
        PlanNode::Readonly { inner } | PlanNode::Lazy { inner } => default_value(plan, *inner),
        _ => None,
    }
}

/// Whether a node supplies a default for an absent input — the non-allocating
/// form of `default_value(..).is_some()` used on the hot object walk.
pub(crate) fn has_default(plan: &CompiledPlan, id: NodeId) -> bool {
    match &plan.nodes()[id as usize] {
        PlanNode::Default { .. } | PlanNode::Prefault { .. } | PlanNode::Catch { .. } => true,
        PlanNode::Readonly { inner } | PlanNode::Lazy { inner } => has_default(plan, *inner),
        _ => false,
    }
}

fn write_pair(key: &str, out: &mut String, first: &mut bool) {
    if !*first {
        out.push(',');
    }
    *first = false;
    out.push_str(&json_string(key));
    out.push(':');
}

fn append_raw(value: &Value, out: &mut String) {
    match sonic_rs::to_string(value) {
        Ok(s) => out.push_str(&s),
        Err(_) => out.push_str("null"),
    }
}

// ------------------------------------------------------------------------
// Value helpers.
// ------------------------------------------------------------------------

/// Scans the raw input for a negative-zero number token (`-0`, `-0.0`,
/// `-0e5`, ...), skipping string contents. sonic-rs normalizes every such
/// token to `0.0`, so a rewrite would lose the sign `JSON.parse` preserves.
fn contains_negative_zero(input: &[u8]) -> bool {
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
        } else if b == b'-' && is_negative_zero_token(&input[i + 1..]) {
            return true;
        }
        i += 1;
    }
    false
}

/// After a `-`: an all-zero mantissa (`0`, `0.0`, ...) with an optional
/// exponent, terminated by a JSON delimiter or the end of input.
fn is_negative_zero_token(rest: &[u8]) -> bool {
    if rest.first() != Some(&b'0') {
        return false;
    }
    let mut i = 1;
    // JSON forbids leading zeros, so a digit here means invalid JSON (which
    // sonic-rs rejects before this scan ever runs); bail out conservatively.
    if rest.get(i).is_some_and(u8::is_ascii_digit) {
        return false;
    }
    if rest.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while rest.get(i) == Some(&b'0') {
            i += 1;
        }
        if i == start || rest.get(i).is_some_and(u8::is_ascii_digit) {
            return false; // empty fraction or a non-zero digit: not zero
        }
    }
    if matches!(rest.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(rest.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while rest.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    matches!(
        rest.get(i),
        None | Some(b',' | b']' | b'}' | b' ' | b'\t' | b'\n' | b'\r')
    )
}

/// Collapse an object's entries to ECMA-262 JSON.parse semantics: one entry per
/// key in first-occurrence order, carrying the last value seen for that key.
fn collapse_object(obj: &Object) -> Vec<(&str, &Value)> {
    let mut order: Vec<&str> = Vec::new();
    let mut last: HashMap<&str, &Value> = HashMap::new();
    for (k, v) in obj {
        if last.insert(k, v).is_none() {
            order.push(k);
        }
    }
    order.into_iter().map(|k| (k, last[k])).collect()
}

/// Converts a container index to a path segment, saturating at `u32::MAX`.
fn idx(i: usize) -> PathSegRef<'static> {
    PathSegRef::Index(u32::try_from(i).unwrap_or(u32::MAX))
}

fn number_of(value: &Value) -> Option<f64> {
    if value.is_number() {
        value.as_f64()
    } else {
        None
    }
}

fn json_eq(value: &Value, lit: &Json) -> bool {
    match lit {
        Json::Null => value.is_null(),
        Json::Bool(b) => value.as_bool() == Some(*b),
        Json::Number(n) => match (value.as_f64(), n.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        },
        Json::String(s) => value.as_str() == Some(s.as_str()),
        _ => false,
    }
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Builds a `serde_json` number from an `f64`, integral when possible so `36`
/// stays `36`.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the branch guard confines the value to the exact i64 range"
)]
fn num_json(n: f64) -> Json {
    if n.fract() == 0.0 && n.is_finite() && n.abs() < 9.007_199_254_740_992e15 {
        Json::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number)
    }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn coerce_to_string(value: &Value) -> String {
    if let Some(b) = value.as_bool() {
        return b.to_string();
    }
    if value.is_number() {
        return value.as_f64().map_or_else(String::new, js_number_to_string);
    }
    value.as_str().unwrap_or_default().to_string()
}

fn coerce_to_number(value: &Value) -> Option<f64> {
    if let Some(s) = value.as_str() {
        return js_number_str(s);
    }
    if let Some(b) = value.as_bool() {
        return Some(if b { 1.0 } else { 0.0 });
    }
    if value.is_null() {
        return Some(0.0); // JS Number(null) === 0
    }
    value.as_f64()
}

/// ECMA-262 `Number(string)`: trims, accepts the exact `Infinity` literal and
/// the `0x`/`0o`/`0b` radix prefixes, and rejects the `inf`/`infinity`/`nan`
/// words that Rust's float parser would accept.
fn js_number_str(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0); // JS Number("") === 0
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let unsigned = t.strip_prefix('+').unwrap_or(t);
    if unsigned.eq_ignore_ascii_case("inf")
        || unsigned.eq_ignore_ascii_case("infinity")
        || unsigned.eq_ignore_ascii_case("nan")
        || t.strip_prefix('-').is_some_and(|r| {
            r.eq_ignore_ascii_case("inf") || r.eq_ignore_ascii_case("infinity") || r.eq_ignore_ascii_case("nan")
        })
    {
        return None;
    }
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return js_radix(rest, 16);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return js_radix(rest, 8);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return js_radix(rest, 2);
    }
    t.parse::<f64>().ok()
}

/// Parses radix-prefixed integer digits, accumulating in `f64` so oversized
/// literals round instead of failing (as JS does).
fn js_radix(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut value = 0.0f64;
    for c in digits.chars() {
        let d = c.to_digit(radix)?;
        value = value * f64::from(radix) + f64::from(d);
    }
    Some(value)
}

/// ECMA-262 `Number::toString`: shortest round-trip digits (via Rust's `{:e}`)
/// placed by JS's fixed-point vs exponential rules.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "digit counts and decimal exponents are tiny and guarded to be non-negative"
)]
fn js_number_to_string(n: f64) -> String {
    if n == 0.0 {
        return "0".into(); // also covers -0
    }
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let negative = n < 0.0;
    let sci = format!("{:e}", n.abs()); // "2.5e4", "3e-1"
    let Some((mantissa, exp)) = sci.split_once('e') else {
        return sci;
    };
    let Ok(exp) = exp.parse::<i32>() else {
        return sci;
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let (k, point) = (digits.len() as i32, exp + 1);
    let body = if (k..=21).contains(&point) {
        // Integral: digits then trailing zeros.
        let mut s = digits;
        s.push_str(&"0".repeat((point - k) as usize));
        s
    } else if (1..=21).contains(&point) {
        // Fixed point inside the digits.
        let at = point as usize;
        format!("{}.{}", &digits[..at], &digits[at..])
    } else if (-5..=0).contains(&point) {
        // Leading "0." with zeros before the digits.
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else {
        // Exponential: one digit, optional fraction, signed exponent.
        let frac = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!("{}{}e{}{}", &digits[..1], frac, if point > 0 { "+" } else { "" }, point - 1)
    };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

/// Mirrors the TS `floatSafeRemainder`: a tolerance-based check that
/// accounts for floating-point rounding in the ratio `value / step`.
pub(crate) fn float_multiple_of(value: f64, step: f64) -> bool {
    if step == 0.0 {
        return false;
    }
    let ratio = value / step;
    let rounded_ratio = ratio.round();
    let tolerance = f64::EPSILON * ratio.abs().max(1.0);
    (ratio - rounded_ratio).abs() < tolerance
}

pub(crate) fn apply_overwrite(s: &str, op: OverwriteOp, _form: Option<&str>) -> String {
    match op {
        OverwriteOp::Trim => s.trim().to_string(),
        OverwriteOp::ToLowerCase => s.to_lowercase(),
        OverwriteOp::ToUpperCase => s.to_uppercase(),
        OverwriteOp::Normalize => s.to_string(), // Unicode NFC handled on the JS path
        OverwriteOp::Slugify => slugify(s),
    }
}

fn slugify(s: &str) -> String {
    let lower = s.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn number_format_id(fmt: NumberFormat) -> &'static str {
    match fmt {
        NumberFormat::Int32 => "int32",
        NumberFormat::Uint32 => "uint32",
        NumberFormat::Float32 => "float32",
        NumberFormat::Float64 => "float64",
        NumberFormat::Safeint => "safeint",
    }
}

pub(crate) fn number_format_range(fmt: NumberFormat) -> (f64, f64) {
    match fmt {
        NumberFormat::Int32 => (-2_147_483_648.0, 2_147_483_647.0),
        NumberFormat::Uint32 => (0.0, 4_294_967_295.0),
        NumberFormat::Float32 => (-3.402_823_466_385_288_6e38, 3.402_823_466_385_288_6e38),
        NumberFormat::Float64 => (f64::MIN, f64::MAX),
        NumberFormat::Safeint => (-MAX_SAFE_INT, MAX_SAFE_INT),
    }
}
