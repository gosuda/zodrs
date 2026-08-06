//! Validation: a `sonic-rs` DOM walked against the compiled plan arena in one
//! pass, tracking the single `dirty` flag that decides the verdict status.
//!
//! `dirty` is set by key stripping, applied defaults, `overwrite` transforms,
//! coercion, and any object whose retained input key order differed from its
//! canonical schema key order. When a valid parse stayed clean the input bytes
//! are already canonical (`status: 0`); when it went dirty the canonical output
//! is rebuilt into `payload` (`status: 1`). Invalid parses emit the raw issue
//! array (`status: 2`). A non-JSON-eligible plan — or input the SIMD parser
//! rejects — returns `status: 3`, telling the caller to fall back to the JS
//! path (which reproduces any `JSON.parse` `SyntaxError` exactly).

use serde_json::Value as Json;
use sonic_rs::{JsonContainerTrait, JsonValueTrait, Value};

use crate::compile::{CompiledCheck, CompiledPlan, LiteralValue, NodeDispatch};
use crate::formats::FormatValidator;
use crate::issue::{issues_to_json, issues_to_value, Issue, Path, PathSeg};
use crate::plan::{BigIntFormat, Check, NodeId, NumberFormat, ObjectMode, OverwriteOp, PlanNode};

/// JavaScript's maximum safe integer, `2^53 - 1`.
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

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
    let value: Value = match sonic_rs::from_slice(input) {
        Ok(v) => v,
        Err(_) => return Verdict::fallback(),
    };

    let mut v = Validator {
        plan,
        issues: Vec::new(),
        path: Path::new(),
        dirty: false,
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
    let mut out = String::new();
    write_output(plan, plan.root(), &value, &mut out);
    Verdict {
        status: 1,
        payload: Some(out),
    }
}

struct Validator<'p> {
    plan: &'p CompiledPlan,
    issues: Vec<Issue>,
    path: Path,
    dirty: bool,
}

impl<'p> Validator<'p> {
    fn node(&self, id: NodeId) -> &'p PlanNode {
        &self.plan.nodes()[id as usize]
    }
    fn dispatch(&self, id: NodeId) -> &'p NodeDispatch {
        &self.plan.dispatch[id as usize]
    }

    fn push(&mut self, issue: Issue) {
        self.issues.push(issue);
    }
    fn invalid_type(&mut self, expected: &str) {
        self.push(Issue::new("invalid_type", &self.path).with("expected", Json::from(expected)));
    }

    /// Validate `value` against node `id`, appending issues on failure.
    #[allow(
        clippy::too_many_lines,
        clippy::match_same_arms,
        reason = "one arm per plan-node kind reads clearer than a split; some distinct kinds share a no-op body"
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
                    self.push(
                        Issue::new("invalid_value", &self.path)
                            .with("values", Json::Array(values.clone())),
                    );
                }
            }

            PlanNode::Object { .. } => self.check_object(id, value),
            PlanNode::Array { element, .. } => {
                let element = *element;
                let Some(arr) = value.as_array() else {
                    return self.invalid_type("array");
                };
                self.array_checks(id, arr.len(), "array");
                for (i, elem) in arr.as_slice().iter().enumerate() {
                    self.path.push(idx(i));
                    self.check(element, elem);
                    self.path.pop();
                }
            }
            PlanNode::Tuple { items, rest } => {
                let items = items.clone();
                let rest = *rest;
                let Some(arr) = value.as_array() else {
                    return self.invalid_type("tuple");
                };
                let slice = arr.as_slice();
                if slice.len() < items.len() {
                    self.push(
                        Issue::new("too_small", &self.path)
                            .with("origin", Json::from("array"))
                            .with("minimum", Json::from(items.len()))
                            .with("inclusive", Json::from(true)),
                    );
                } else if slice.len() > items.len() && rest.is_none() {
                    self.push(
                        Issue::new("too_big", &self.path)
                            .with("origin", Json::from("array"))
                            .with("maximum", Json::from(items.len()))
                            .with("inclusive", Json::from(true)),
                    );
                }
                for (i, item_id) in items.iter().enumerate() {
                    if let Some(elem) = slice.get(i) {
                        self.path.push(idx(i));
                        self.check(*item_id, elem);
                        self.path.pop();
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
                let options = options.clone();
                self.check_union(&options, value);
            }
            PlanNode::DiscUnion { key, .. } => {
                let key = key.clone();
                self.check_disc_union(id, &key, value);
            }
            PlanNode::Intersection { left, right } => {
                let (left, right) = (*left, *right);
                self.check(left, value);
                self.check(right, value);
            }
            PlanNode::Record { key, value: val } => {
                let (key_id, val_id) = (*key, *val);
                let Some(obj) = value.as_object() else {
                    return self.invalid_type("object");
                };
                for (k, entry) in obj {
                    // Record key validation (invalid_key on failure).
                    let key_val: Value = sonic_rs::from_str(&json_string(k)).unwrap_or_default();
                    let before = self.issues.len();
                    let saved = std::mem::take(&mut self.path);
                    self.check(key_id, &key_val);
                    let key_issues = self.issues.split_off(before);
                    self.path = saved;
                    if !key_issues.is_empty() {
                        self.push(
                            Issue::new("invalid_key", &self.path)
                                .with("origin", Json::from("record"))
                                .with("issues", issues_to_value(&key_issues)),
                        );
                    }
                    self.path.push(PathSeg::Key(k.to_string()));
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
                let before = self.issues.len();
                self.check(inner, value);
                if self.issues.len() != before {
                    self.issues.truncate(before);
                    self.dirty = true; // catch value replaces the input
                }
            }
            PlanNode::Pipe { a, b } => {
                let (a, b) = (*a, *b);
                let before = self.issues.len();
                self.check(a, value);
                if self.issues.len() == before {
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
                    self.push(
                        Issue::new("invalid_format", &self.path)
                            .with("origin", Json::from("string"))
                            .with("format", Json::from("template_literal")),
                    );
                }
            }
            PlanNode::Host { .. } => {} // unreachable: host poisons eligibility
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "length bounds are small, non-negative integers"
    )]
    fn check_string(&mut self, id: NodeId, value: &Value, coerce: bool) {
        let mut cur: String;
        if let Some(s) = value.as_str() {
            cur = s.to_string();
        } else if coerce && (value.is_number() || value.is_boolean()) {
            cur = coerce_to_string(value);
            self.dirty = true;
        } else {
            return self.invalid_type("string");
        }

        let PlanNode::String { checks, .. } = self.node(id) else {
            return;
        };
        let checks = checks.clone();
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
                        self.string_format("starts_with", &[("prefix", Json::from(v.clone()))]);
                    }
                }
                Check::EndsWith { v } => {
                    if !cur.ends_with(v) {
                        self.string_format("ends_with", &[("suffix", Json::from(v.clone()))]);
                    }
                }
                Check::Includes { v, position } => {
                    let found = match position {
                        Some(p) => cur.get(*p..).is_some_and(|tail| tail.contains(v)),
                        None => cur.contains(v),
                    };
                    if !found {
                        self.string_format("includes", &[("includes", Json::from(v.clone()))]);
                    }
                }
                Check::Lowercase => {
                    if cur.chars().any(char::is_uppercase) {
                        self.string_format("lowercase", &[]);
                    }
                }
                Check::Uppercase => {
                    if cur.chars().any(char::is_lowercase) {
                        self.string_format("uppercase", &[]);
                    }
                }
                Check::Regex { .. } => {
                    if let Some(Some(CompiledCheck::Regex(re))) = compiled.get(ci)
                        && !re.is_match(&cur)
                    {
                        self.string_format("regex", &[]);
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
                    if next != cur {
                        self.dirty = true;
                    }
                    cur = next;
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
        let checks = checks.clone();
        for check in &checks {
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
                        self.push(
                            Issue::new("not_multiple_of", &self.path)
                                .with("origin", Json::from("number"))
                                .with("divisor", num_json(d)),
                        );
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
                self.push(
                    Issue::new("invalid_type", &self.path)
                        .with("expected", Json::from("int"))
                        .with("format", Json::from(number_format_id(fmt))),
                );
                return;
            }
            if n.abs() > MAX_SAFE_INT {
                if n > 0.0 {
                    self.push(
                        Issue::new("too_big", &self.path)
                            .with("origin", Json::from("int"))
                            .with("maximum", num_json(MAX_SAFE_INT))
                            .with("inclusive", Json::from(true))
                            .with(
                                "note",
                                Json::from("Integers must be within the safe integer range."),
                            ),
                    );
                } else {
                    self.push(
                        Issue::new("too_small", &self.path)
                            .with("origin", Json::from("int"))
                            .with("minimum", num_json(-MAX_SAFE_INT))
                            .with("inclusive", Json::from(true))
                            .with(
                                "note",
                                Json::from("Integers must be within the safe integer range."),
                            ),
                    );
                }
                return;
            }
        }
        let (min, max) = number_format_range(fmt);
        if n < min {
            self.push(
                Issue::new("too_small", &self.path)
                    .with("origin", Json::from("number"))
                    .with("minimum", num_json(min))
                    .with("inclusive", Json::from(true)),
            );
        }
        if n > max {
            self.push(
                Issue::new("too_big", &self.path)
                    .with("origin", Json::from("number"))
                    .with("maximum", num_json(max))
                    .with("inclusive", Json::from(true)),
            );
        }
    }

    fn bigint_format(&mut self, fmt: BigIntFormat, n: f64) {
        let (min, max) = match fmt {
            BigIntFormat::Int64 => (-9_223_372_036_854_775_808.0, 9_223_372_036_854_775_807.0),
            BigIntFormat::Uint64 => (0.0, 18_446_744_073_709_551_615.0),
        };
        if n < min {
            self.too_small("bigint", min, true, false);
        }
        if n > max {
            self.too_big("bigint", max, true, false);
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
        let checks = checks.clone();
        let len_f = len as f64;
        for check in &checks {
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

    fn check_object(&mut self, id: NodeId, value: &Value) {
        let PlanNode::Object {
            keys,
            values,
            optional,
            mode,
            catchall,
        } = self.node(id)
        else {
            return;
        };
        let keys = keys.clone();
        let values = values.clone();
        let optional = optional.clone();
        let mode = *mode;
        let catchall = *catchall;

        let Some(obj) = value.as_object() else {
            return self.invalid_type("object");
        };

        let mut seen = vec![false; keys.len()];
        let mut unknown_keys: Vec<String> = Vec::new();
        let mut known_order: Vec<usize> = Vec::new();

        for (in_key, in_val) in obj {
            if let Some(schema_i) = self.dispatch(id).object.as_ref().and_then(|o| o.find(in_key)) {
                seen[schema_i] = true;
                known_order.push(schema_i);
                self.path.push(PathSeg::Key(in_key.to_string()));
                self.check(values[schema_i], in_val);
                self.path.pop();
            } else if let Some(catchall_id) = catchall {
                self.path.push(PathSeg::Key(in_key.to_string()));
                self.check(catchall_id, in_val);
                self.path.pop();
            } else {
                match mode {
                    // Strip drops unknowns; passthrough retains them after the
                    // schema keys — both rewrite the input, so both go dirty.
                    ObjectMode::Strip | ObjectMode::Passthrough => self.dirty = true,
                    ObjectMode::Strict => unknown_keys.push(in_key.to_string()),
                }
            }
        }

        // Retained known keys not in ascending schema order => reorder => dirty.
        if known_order.windows(2).any(|w| w[0] > w[1]) {
            self.dirty = true;
        }

        // Missing keys: apply defaults, skip optionals, else invalid_type.
        for (schema_i, present) in seen.iter().enumerate() {
            if *present {
                continue;
            }
            match self.missing_kind(values[schema_i]) {
                Missing::Default => self.dirty = true,
                Missing::Optional => {}
                Missing::Required => {
                    self.path.push(PathSeg::Key(keys[schema_i].clone()));
                    let expected = self.expected_name(values[schema_i]);
                    self.invalid_type(&expected);
                    self.path.pop();
                    let _ = &optional; // optional[] is advisory; node kind is authoritative
                }
            }
        }

        if mode == ObjectMode::Strict && !unknown_keys.is_empty() {
            self.push(
                Issue::new("unrecognized_keys", &self.path).with(
                    "keys",
                    Json::Array(unknown_keys.into_iter().map(Json::from).collect()),
                ),
            );
        }
    }

    fn check_union(&mut self, options: &[NodeId], value: &Value) {
        let mut branch_errors: Vec<Json> = Vec::new();
        for opt in options {
            let before = self.issues.len();
            let dirty_before = self.dirty;
            self.check(*opt, value);
            if self.issues.len() == before {
                return; // first successful option wins
            }
            let branch = self.issues.split_off(before);
            branch_errors.push(issues_to_value(&branch));
            self.dirty = dirty_before;
        }
        self.push(Issue::new("invalid_union", &self.path).with("errors", Json::Array(branch_errors)));
    }

    fn check_disc_union(&mut self, id: NodeId, disc_key: &str, value: &Value) {
        let Some(obj) = value.as_object() else {
            return self.invalid_type("object");
        };
        let disc = obj.get(&disc_key);
        let target = disc.and_then(LiteralValue::from_value).and_then(|k| {
            self.dispatch(id)
                .disc_union
                .as_ref()
                .and_then(|m| m.get(&k).copied())
        });
        match target {
            Some(node) => self.check(node, value),
            None => self.push(
                Issue::new("invalid_union", &self.path)
                    .with("errors", Json::Array(Vec::new()))
                    .with("note", Json::from("No matching discriminator")),
            ),
        }
    }

    // ---- issue helpers -------------------------------------------------

    fn too_small(&mut self, origin: &str, minimum: f64, inclusive: bool, exact: bool) {
        let mut issue = Issue::new("too_small", &self.path)
            .with("origin", Json::from(origin))
            .with("minimum", num_json(minimum))
            .with("inclusive", Json::from(inclusive));
        if exact {
            issue = issue.with("exact", Json::from(true));
        }
        self.push(issue);
    }
    fn too_big(&mut self, origin: &str, maximum: f64, inclusive: bool, exact: bool) {
        let mut issue = Issue::new("too_big", &self.path)
            .with("origin", Json::from(origin))
            .with("maximum", num_json(maximum))
            .with("inclusive", Json::from(inclusive));
        if exact {
            issue = issue.with("exact", Json::from(true));
        }
        self.push(issue);
    }
    fn string_format(&mut self, format: &'static str, extra: &[(&'static str, Json)]) {
        let mut issue = Issue::new("invalid_format", &self.path)
            .with("origin", Json::from("string"))
            .with("format", Json::from(format));
        for (k, v) in extra {
            issue = issue.with(k, v.clone());
        }
        self.push(issue);
    }
    fn format_issue(&mut self, f: &FormatValidator) {
        self.push(
            Issue::new("invalid_format", &self.path)
                .with("origin", Json::from("string"))
                .with("format", Json::from(f.id.clone())),
        );
    }

    // ---- missing-key / expected-type resolution ------------------------

    fn missing_kind(&self, id: NodeId) -> Missing {
        match self.node(id) {
            PlanNode::Optional { .. } => Missing::Optional,
            PlanNode::Default { .. } | PlanNode::Prefault { .. } | PlanNode::Catch { .. } => {
                Missing::Default
            }
            PlanNode::Readonly { inner } | PlanNode::Lazy { inner } => self.missing_kind(*inner),
            PlanNode::Any | PlanNode::Unknown | PlanNode::Void | PlanNode::Undefined => {
                Missing::Optional
            }
            _ => Missing::Required,
        }
    }

    fn expected_name(&self, id: NodeId) -> String {
        match self.node(id) {
            PlanNode::String { .. } => "string",
            PlanNode::Number { .. } => "number",
            PlanNode::Boolean { .. } => "boolean",
            PlanNode::BigInt { .. } => "bigint",
            PlanNode::Date { .. } => "date",
            PlanNode::File { .. } => "file",
            PlanNode::Symbol => "symbol",
            PlanNode::Object { .. } => "object",
            PlanNode::Array { .. } => "array",
            PlanNode::Tuple { .. } => "tuple",
            PlanNode::Record { .. } => "record",
            PlanNode::Map { .. } => "map",
            PlanNode::Set { .. } => "set",
            PlanNode::Nan => "nan",
            PlanNode::NonOptional { .. } => "nonoptional",
            PlanNode::Nullable { inner }
            | PlanNode::Readonly { inner }
            | PlanNode::Lazy { inner } => return self.expected_name(*inner),
            _ => "unknown",
        }
        .to_string()
    }
}

enum Missing {
    Required,
    Optional,
    Default,
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
            out.push('{');
            let mut first = true;
            let disp = plan.dispatch[id as usize].object.as_ref();
            // Canonical schema key order.
            for (schema_i, key) in keys.iter().enumerate() {
                if let Some(child) = obj.get(&key) {
                    write_pair(key, out, &mut first);
                    write_output(plan, values[schema_i], child, out);
                } else if let Some(def) = default_value(plan, values[schema_i]) {
                    write_pair(key, out, &mut first);
                    out.push_str(&serde_json::to_string(&def).unwrap_or_else(|_| "null".into()));
                }
            }
            // Retained unknowns (passthrough / catchall) after schema keys.
            if *mode == ObjectMode::Passthrough || catchall.is_some() {
                for (k, v) in obj {
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
            out.push('[');
            for (i, elem) in arr.as_slice().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let child = items.get(i).copied().or(*rest);
                match child {
                    Some(c) => write_output(plan, c, elem, out),
                    None => append_raw(elem, out),
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
            for (k, v) in obj {
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
        PlanNode::Optional { inner }
        | PlanNode::NonOptional { inner }
        | PlanNode::Readonly { inner }
        | PlanNode::Lazy { inner }
        | PlanNode::Promise { inner }
        | PlanNode::Default { inner, .. }
        | PlanNode::Prefault { inner, .. }
        | PlanNode::Catch { inner, .. } => {
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
                .and_then(|o| o.get(&key.as_str()))
                .and_then(LiteralValue::from_value)
                .and_then(|k| {
                    plan.dispatch[id as usize]
                        .disc_union
                        .as_ref()
                        .and_then(|m| m.get(&k).copied())
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
        path: Path::new(),
        dirty: false,
    };
    v.check(id, value);
    v.issues.is_empty()
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

/// Converts a container index to a path segment, saturating at `u32::MAX`.
fn idx(i: usize) -> PathSeg {
    PathSeg::Index(u32::try_from(i).unwrap_or(u32::MAX))
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

fn utf16_len(s: &str) -> usize {
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
        return sonic_rs::to_string(value).unwrap_or_default();
    }
    value.as_str().unwrap_or_default().to_string()
}

fn coerce_to_number(value: &Value) -> Option<f64> {
    if let Some(s) = value.as_str() {
        let t = s.trim();
        if t.is_empty() {
            return Some(0.0); // JS Number("") === 0
        }
        return t.parse::<f64>().ok();
    }
    if let Some(b) = value.as_bool() {
        return Some(if b { 1.0 } else { 0.0 });
    }
    value.as_f64()
}

/// Zod's `floatSafeRemainder`: integer-scale the operands to dodge FP drift.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    reason = "decimal digit counts are tiny non-negative integers"
)]
fn float_multiple_of(value: f64, step: f64) -> bool {
    if step == 0.0 {
        return false;
    }
    let val_dec = decimals(value);
    let step_dec = decimals(step);
    let dec_count = val_dec.max(step_dec);
    let scale = 10f64.powi(dec_count as i32);
    let v = (value * scale).round();
    let s = (step * scale).round();
    (v % s) == 0.0
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "fractional digit counts fit u32 for any real number"
)]
fn decimals(n: f64) -> u32 {
    let s = format!("{n}");
    match s.split_once('.') {
        Some((_, frac)) => frac.len() as u32,
        None => 0,
    }
}

fn apply_overwrite(s: &str, op: OverwriteOp, _form: Option<&str>) -> String {
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

fn number_format_range(fmt: NumberFormat) -> (f64, f64) {
    match fmt {
        NumberFormat::Int32 => (-2_147_483_648.0, 2_147_483_647.0),
        NumberFormat::Uint32 => (0.0, 4_294_967_295.0),
        NumberFormat::Float32 => (-3.402_823_466_385_288_6e38, 3.402_823_466_385_288_6e38),
        NumberFormat::Float64 => (f64::MIN, f64::MAX),
        NumberFormat::Safeint => (-MAX_SAFE_INT, MAX_SAFE_INT),
    }
}
