//! Single-pass byte validation: the hot path of [`crate::validate`].
//!
//! The scanner walks the plan against the raw input bytes directly — no DOM,
//! no allocation, no issue machinery. It returns [`Scan::Clean`] only when the
//! input is provably valid JSON whose DOM walk would end valid with the
//! `dirty` flag clear (verdict status 0). Every other outcome — dirty,
//! invalid, or a construct the scanner does not model — defers to the DOM
//! walk, which owns all rewrite, issue, and fallback behavior.
//!
//! Over-acceptance is safe by construction: the JS wrapper `JSON.parse`s the
//! original bytes on both the status-0 and the fallback paths, so accepting a
//! token `JSON.parse` would reject (e.g. a raw control byte in a string)
//! surfaces the identical `SyntaxError` on either path.

use serde_json::Value as Json;
use smallvec::SmallVec;

use crate::compile::{CompiledCheck, CompiledPlan, NodeDispatch};
use crate::plan::{Check, NodeId, PlanNode};
use crate::validate::{apply_overwrite, float_multiple_of, number_format_range, utf16_len};

/// JavaScript's maximum safe integer, `2^53 - 1`.
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

/// Recursion ceiling for nested containers. Beyond it the scanner defers to
/// the DOM walk rather than risk its own stack.
const MAX_DEPTH: u32 = 128;

/// Outcome of the single-pass scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Scan {
    /// Valid JSON, valid against the plan, already canonical: status 0.
    Clean,
    /// Defer to the DOM walk (dirty, invalid, or unmodeled construct).
    Defer,
}

/// Runs the single-pass scan over `input`.
#[must_use]
pub fn scan(plan: &CompiledPlan, input: &[u8]) -> Scan {
    let mut s = Scanner {
        plan,
        b: input,
        i: 0,
        depth: 0,
        dirty_hint: false,
    };
    s.ws();
    if s.value(plan.root()) {
        s.ws();
        if s.i == input.len() && !s.dirty_hint {
            return Scan::Clean;
        }
    }
    Scan::Defer
}

struct Scanner<'a> {
    plan: &'a CompiledPlan,
    /// The input bytes.
    b: &'a [u8],
    /// Cursor position.
    i: usize,
    depth: u32,
    /// Set when the input validates (or may validate) only with a rewrite —
    /// catch/default application, stripped or reordered keys, overwrite
    /// checks, coercions — or when a construct is too complex to model.
    /// Zod unions pick the FIRST option that validates at all (rewrites
    /// included), so a rewrite-validating option must not be skipped the way
    /// a hard failure is; once set, the verdict is `Defer` regardless, and
    /// every further check short-circuits.
    dirty_hint: bool,
}

/// SWAR constants for the inline string scanner.
const SWAR_LO: u64 = u64::from_ne_bytes([1; 8]);
const SWAR_HI: u64 = SWAR_LO * 0x80;

/// Word-at-a-time byte detection: returns a word with the high bit set in
/// each lane where `word` holds `needle`.
#[inline]
fn swar_has_byte(word: u64, needle: u8) -> u64 {
    let x = word ^ (SWAR_LO * u64::from(needle));
    x.wrapping_sub(SWAR_LO) & !x & SWAR_HI
}

/// Finds the next `"` or `\` in `b`, also reporting whether any scanned byte
/// (up to and slightly past the hit, within the final word) has the high bit
/// set. A clean report lets callers skip UTF-8 validation for pure-ASCII
/// spans; an over-report only costs a checked validation, never correctness.
#[inline]
fn find_quote_or_escape(b: &[u8]) -> Option<(usize, bool)> {
    let mut j = 0;
    let mut non_ascii = false;
    while let Some(chunk) = b.get(j..j + 8) {
        let word = u64::from_le_bytes(chunk.try_into().ok()?);
        non_ascii |= (word & SWAR_HI) != 0;
        let hits = swar_has_byte(word, b'"') | swar_has_byte(word, b'\\');
        if hits != 0 {
            return Some((j + (hits.trailing_zeros() / 8) as usize, non_ascii));
        }
        j += 8;
    }
    while j < b.len() {
        let c = b[j];
        if c == b'"' || c == b'\\' {
            return Some((j, non_ascii));
        }
        non_ascii |= c & 0x80 != 0;
        j += 1;
    }
    None
}

impl<'a> Scanner<'a> {
    fn node(&self, id: NodeId) -> &'a PlanNode {
        &self.plan.nodes()[id as usize]
    }
    fn dispatch(&self, id: NodeId) -> &'a NodeDispatch {
        &self.plan.dispatch[id as usize]
    }

    /// Skips JSON whitespace (space, tab, LF, CR — the `JSON.parse` set).
    fn ws(&mut self) {
        while let Some(&b) = self.b.get(self.i) {
            if !matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                return;
            }
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    /// Consumes a literal token at the cursor.
    fn eat(&mut self, tok: &[u8]) -> bool {
        if self.b.get(self.i..self.i + tok.len()) == Some(tok) {
            self.i += tok.len();
            true
        } else {
            false
        }
    }

    /// Parses an object key token as raw bytes. Keys match schema keys by
    /// byte equality, so no UTF-8 validation is needed: an invalid-UTF-8 key
    /// can never equal a (valid-UTF-8) schema key, and unknown keys defer to
    /// the DOM walk, which rejects the input at the sonic parse.
    #[inline]
    fn key_token(&mut self) -> Option<&'a [u8]> {
        if self.peek() != Some(b'"') {
            return None;
        }
        let start = self.i + 1;
        let (at, _) = find_quote_or_escape(&self.b[start..])?;
        let at = at + start;
        if self.b[at] == b'\\' {
            return None; // escaped key: defer
        }
        self.i = at + 1;
        Some(&self.b[start..at])
    }

    /// Parses a string token, returning the borrowed contents. Any escape
    /// sequence defers (rare in hot payloads; the DOM walk owns decoding).
    #[inline]
    fn string_token(&mut self) -> Option<&'a str> {
        if self.peek() != Some(b'"') {
            return None;
        }
        let start = self.i + 1;
        let (at, non_ascii) = find_quote_or_escape(&self.b[start..])?;
        let at = at + start;
        if self.b[at] == b'\\' {
            return None; // escaped content: defer
        }
        let span = &self.b[start..at];
        // Pure-ASCII spans (the common case) take the validator's fast path;
        // the scan's high-bit report is advisory only.
        let _ = non_ascii;
        let s = std::str::from_utf8(span).ok()?;
        self.i = at + 1;
        Some(s)
    }

    /// Parses a strict JSON number token. Integers up to 15 digits are
    /// accumulated exactly; longer forms go through the correctly-rounded
    /// standard parser.
    #[allow(
        clippy::cast_precision_loss,
        reason = "the 15-digit guard confines the u64 to the exact f64 range"
    )]
    fn number_token(&mut self) -> Option<f64> {
        let b = &self.b[self.i..];
        let mut j = 0;
        if b.first() == Some(&b'-') {
            j += 1;
        }
        // Integer part: `0` or `[1-9][0-9]*`.
        let int_start = j;
        match b.get(j)? {
            b'0' => {
                j += 1;
            }
            b'1'..=b'9' => {
                j += 1;
                while b.get(j).is_some_and(u8::is_ascii_digit) {
                    j += 1;
                }
            }
            _ => return None,
        }
        let int_len = j - int_start;
        let mut floating = false;
        if b.get(j) == Some(&b'.') {
            floating = true;
            j += 1;
            let frac_start = j;
            while b.get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j == frac_start {
                return None;
            }
        }
        if matches!(b.get(j), Some(b'e' | b'E')) {
            floating = true;
            j += 1;
            if matches!(b.get(j), Some(b'+' | b'-')) {
                j += 1;
            }
            let exp_start = j;
            while b.get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j == exp_start {
                return None;
            }
        }
        let negative = b.first() == Some(&b'-');
        if !floating && int_len <= 15 {
            // All scanned bytes are ASCII digits: accumulate exactly.
            let mut n: u64 = 0;
            for &d in &b[int_start..int_start + int_len] {
                n = n * 10 + u64::from(d - b'0');
            }
            // n <= 999_999_999_999_999 < 2^53: exactly representable.
            self.i += j;
            return Some(if negative { -(n as f64) } else { n as f64 });
        }
        // Every accepted byte is an ASCII grammar character, so the token is
        // valid UTF-8 by construction.
        let token = std::str::from_utf8(&b[..j]).ok()?;
        let n = token.parse::<f64>().ok()?;
        // Overflow (`1e400`): sonic's `as_f64` yields nothing for it, so the
        // DOM walk reports `invalid_type` — defer to keep that behavior.
        if !n.is_finite() {
            return None;
        }
        self.i += j;
        Some(n)
    }

    /// Skips one arbitrary JSON value, containers included.
    fn skip_value(&mut self) -> bool {
        self.ws();
        if self.depth >= MAX_DEPTH {
            self.dirty_hint = true;
            return false;
        }
        match self.peek() {
            Some(b'"') => self.skip_string(),
            Some(b'{') => {
                self.depth += 1;
                self.i += 1;
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    self.depth -= 1;
                    return true;
                }
                loop {
                    self.ws();
                    if !self.skip_string() {
                        return false;
                    }
                    self.ws();
                    if self.peek() != Some(b':') {
                        return false;
                    }
                    self.i += 1;
                    if !self.skip_value() {
                        return false;
                    }
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            self.depth -= 1;
                            return true;
                        }
                        _ => return false,
                    }
                }
            }
            Some(b'[') => {
                self.depth += 1;
                self.i += 1;
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    self.depth -= 1;
                    return true;
                }
                loop {
                    if !self.skip_value() {
                        return false;
                    }
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            self.depth -= 1;
                            return true;
                        }
                        _ => return false,
                    }
                }
            }
            Some(b't') => self.eat(b"true"),
            Some(b'f') => self.eat(b"false"),
            Some(b'n') => self.eat(b"null"),
            Some(b'-' | b'0'..=b'9') => self.number_token().is_some(),
            _ => false,
        }
    }

    /// Skips a string token, honoring escaped quotes.
    fn skip_string(&mut self) -> bool {
        if self.peek() != Some(b'"') {
            return false;
        }
        let mut off = self.i + 1;
        loop {
            let Some(tail) = self.b.get(off..) else {
                return false;
            };
            let Some((at, _)) = find_quote_or_escape(tail) else {
                return false;
            };
            let at = at + off;
            if self.b[at] == b'"' {
                self.i = at + 1;
                return true;
            }
            // Skip the escape introducer and its first escaped byte; the
            // remaining bytes of a `\uXXXX` escape are plain characters.
            off = at + 2;
        }
    }

    /// Validates the value at the cursor against node `id`. On `true` the
    /// value was valid and canonical; on `false` the caller defers.
    #[allow(
        clippy::too_many_lines,
        clippy::match_same_arms,
        reason = "one arm per plan-node kind; distinct kinds sharing a defer body read clearer together"
    )]
    fn value(&mut self, id: NodeId) -> bool {
        if self.dirty_hint {
            // The verdict is already Defer; spare the remaining work.
            return true;
        }
        match self.node(id) {
            PlanNode::Any | PlanNode::Unknown => self.skip_value(),
            PlanNode::Null => self.eat(b"null"),
            PlanNode::Boolean { coerce } => {
                if *coerce {
                    self.dirty_hint = true; // coercion semantics live in the DOM walk
                    return false;
                }
                self.eat(b"true") || self.eat(b"false")
            }
            PlanNode::Literal { values } | PlanNode::Enum { values } => self.literal(values),
            PlanNode::String { checks, coerce } => {
                if *coerce {
                    self.dirty_hint = true;
                    return false;
                }
                if checks.is_empty() {
                    // No checks: content is irrelevant, so escapes and even
                    // invalid UTF-8 need no decoding here — the JS wrapper's
                    // `JSON.parse` reproduces the exact same value on either
                    // verdict path.
                    return self.skip_string();
                }
                let Some(s) = self.string_token() else {
                    // Escaped content: zod may validate it (clean or with a
                    // rewrite); the scan cannot model it.
                    self.dirty_hint = true;
                    return false;
                };
                self.string_checks(id, s)
            }
            PlanNode::Number { coerce, .. } => {
                if *coerce {
                    self.dirty_hint = true;
                    return false;
                }
                let Some(n) = self.number_token() else {
                    return false;
                };
                self.number_checks(id, n)
            }
            PlanNode::Object { .. } => self.object(id),
            PlanNode::Array { element, .. } => {
                let element = *element;
                if self.depth >= MAX_DEPTH {
                    self.dirty_hint = true;
                    return false;
                }
                self.depth += 1;
                let ok = self.array(id, element);
                self.depth -= 1;
                ok
            }
            PlanNode::Tuple { .. } => self.tuple(id),
            PlanNode::Union { options } => {
                // Zod picks the first option that validates AT ALL — rewrites
                // included. A clean scan proves the union only when every
                // earlier option failed HARD: rewrite-validating options set
                // `dirty_hint` and return true here, preserving that order;
                // anything the scan cannot model sets the hint on failure, so
                // a later clean option can never shadow an earlier dirty one.
                let mark = self.i;
                for opt in options {
                    self.i = mark;
                    if self.value(*opt) {
                        return true;
                    }
                }
                false
            }
            PlanNode::DiscUnion { key, .. } => self.disc_union(id, key),
            PlanNode::Intersection { left, right } => {
                let (left, right) = (*left, *right);
                self.value(left) && self.value(right)
            }
            PlanNode::Record { .. } => self.record(id),
            PlanNode::Optional { inner }
            | PlanNode::NonOptional { inner }
            | PlanNode::Readonly { inner }
            | PlanNode::Lazy { inner }
            | PlanNode::Promise { inner }
            | PlanNode::Default { inner, .. }
            | PlanNode::Prefault { inner, .. } => {
                let inner = *inner;
                self.value(inner)
            }
            PlanNode::Nullable { inner } => {
                if self.peek() == Some(b'n') {
                    self.eat(b"null")
                } else {
                    let inner = *inner;
                    self.value(inner)
                }
            }
            PlanNode::Catch { .. } => {
                // A clean inner value stays clean; a failure fires the catch,
                // which rewrites the output: the node validates dirty.
                let mark = self.i;
                let PlanNode::Catch { inner, .. } = self.node(id) else {
                    return false;
                };
                let inner = *inner;
                if self.value(inner) {
                    true
                } else {
                    self.i = mark;
                    self.dirty_hint = true;
                    true
                }
            }
            PlanNode::Pipe { a, b } => {
                let (a, b) = (*a, *b);
                self.value(a) && self.value(b)
            }
            PlanNode::TemplateLiteral { .. } => {
                if self.peek() != Some(b'"') {
                    return false; // genuine invalid_type
                }
                let Some(s) = self.string_token() else {
                    // Escaped content: the pattern may match the decoded
                    // text; the scan cannot decode it.
                    self.dirty_hint = true;
                    return false;
                };
                match &self.dispatch(id).template {
                    Some(re) => re.is_match(s),
                    None => false,
                }
            }
            // Coerced, host-flavored, or non-JSON kinds: the DOM walk owns them.
            PlanNode::BigInt { .. }
            | PlanNode::Date { .. }
            | PlanNode::File { .. }
            | PlanNode::Map { .. }
            | PlanNode::Set { .. }
            | PlanNode::Never
            | PlanNode::Undefined
            | PlanNode::Void
            | PlanNode::Nan
            | PlanNode::Symbol
            | PlanNode::Host { .. } => false,
        }
    }

    /// Matches the value at the cursor against one of the allowed literals.
    fn literal(&mut self, values: &[Json]) -> bool {
        for lit in values {
            match lit {
                Json::Null => {
                    if self.eat(b"null") {
                        return true;
                    }
                }
                Json::Bool(true) => {
                    if self.eat(b"true") {
                        return true;
                    }
                }
                Json::Bool(false) => {
                    if self.eat(b"false") {
                        return true;
                    }
                }
                Json::Number(n) => {
                    let mark = self.i;
                    if let Some(v) = self.number_token()
                        && n.as_f64() == Some(v)
                    {
                        return true;
                    }
                    self.i = mark;
                }
                Json::String(s) => {
                    let mark = self.i;
                    if let Some(v) = self.string_token()
                        && v == s.as_str()
                    {
                        return true;
                    }
                    self.i = mark;
                }
                _ => {}
            }
        }
        false
    }

    /// String checks against the borrowed contents; `false` defers.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "length bounds are small, non-negative integers"
    )]
    fn string_checks(&mut self, id: NodeId, s: &str) -> bool {
        let PlanNode::String { checks, .. } = self.node(id) else {
            return false;
        };
        let compiled = &self.dispatch(id).checks;
        let s_len = if s.is_ascii() { s.len() } else { utf16_len(s) };
        for (ci, check) in checks.iter().enumerate() {
            let ok = match check {
                Check::MinLength { v } => s_len >= *v as usize,
                Check::MaxLength { v } => s_len <= *v as usize,
                Check::Length { v } => {
                    (s_len as f64).partial_cmp(v) == Some(std::cmp::Ordering::Equal)
                }
                Check::StartsWith { v } => s.starts_with(v),
                Check::EndsWith { v } => s.ends_with(v),
                Check::Includes { v, position } => match position {
                    Some(p) => s.get(*p..).is_some_and(|tail| tail.contains(v)),
                    None => s.contains(v),
                },
                Check::Lowercase => !s.chars().any(char::is_uppercase),
                Check::Uppercase => !s.chars().any(char::is_lowercase),
                Check::Regex { .. } => match compiled.get(ci) {
                    Some(Some(CompiledCheck::Regex(re))) => re.is_match(s),
                    _ => true, // uncompiled (non-eligible) plans never scan
                },
                Check::Format { .. } => match compiled.get(ci) {
                    Some(Some(CompiledCheck::Format(f))) => f.is_valid(s),
                    _ => true,
                },
                Check::Overwrite { op, form } => {
                    // Unchanged text stays clean; a rewrite validates dirty.
                    // Subsequent checks see the rewritten text in the DOM
                    // walk, but the hint already forces a defer, so checking
                    // the original text here is harmless either way.
                    if apply_overwrite(s, *op, form.as_deref()) != s {
                        self.dirty_hint = true;
                    }
                    true
                }
                _ => true,
            };
            if !ok {
                return false;
            }
            if self.dirty_hint {
                return true;
            }
        }
        true
    }

    /// Number checks against the parsed value; `false` defers.
    fn number_checks(&mut self, id: NodeId, n: f64) -> bool {
        let PlanNode::Number { checks, .. } = self.node(id) else {
            return false;
        };
        for check in checks {
            let ok = match check {
                Check::Gt { v, inclusive, .. } => {
                    let bound = v.as_f64().unwrap_or(f64::NEG_INFINITY);
                    if *inclusive { n >= bound } else { n > bound }
                }
                Check::Lt { v, inclusive, .. } => {
                    let bound = v.as_f64().unwrap_or(f64::INFINITY);
                    if *inclusive { n <= bound } else { n < bound }
                }
                Check::MultipleOf { v } => float_multiple_of(n, v.as_f64().unwrap_or(1.0)),
                Check::NumberFormat { v } => number_format_scan(*v, n),
                Check::BigIntFormat { v } => {
                    let (min, max) = match v {
                        crate::plan::BigIntFormat::Int64 => {
                            (-9_223_372_036_854_775_808.0, 9_223_372_036_854_775_807.0)
                        }
                        crate::plan::BigIntFormat::Uint64 => (0.0, 18_446_744_073_709_551_615.0),
                    };
                    n >= min && n <= max
                }
                _ => true,
            };
            if !ok {
                return false;
            }
        }
        true
    }

    /// Leaf-kind fast dispatch shared by `value` and `field`. Returns
    /// `None` when `id` is not a leaf kind and the caller must recurse.
    #[inline]
    fn leaf(&mut self, id: NodeId) -> Option<bool> {
        match self.node(id) {
            PlanNode::String { checks, coerce } => {
                if *coerce {
                    self.dirty_hint = true;
                    return Some(false);
                }
                if checks.is_empty() {
                    return Some(self.skip_string());
                }
                let Some(s) = self.string_token() else {
                    self.dirty_hint = true;
                    return Some(false);
                };
                Some(self.string_checks(id, s))
            }
            PlanNode::Number { coerce, .. } => {
                if *coerce {
                    self.dirty_hint = true;
                    return Some(false);
                }
                let Some(n) = self.number_token() else {
                    return Some(false);
                };
                Some(self.number_checks(id, n))
            }
            PlanNode::Boolean { coerce } => {
                if *coerce {
                    self.dirty_hint = true;
                    return Some(false);
                }
                Some(self.eat(b"true") || self.eat(b"false"))
            }
            PlanNode::Null => Some(self.eat(b"null")),
            PlanNode::Literal { values } | PlanNode::Enum { values } => Some(self.literal(values)),
            _ => None,
        }
    }

    /// Field-value dispatch for object properties: leaf kinds validate
    /// inline without a recursive `value()` call; containers recurse.
    fn field(&mut self, id: NodeId) -> bool {
        if self.dirty_hint {
            return true;
        }
        if let Some(result) = self.leaf(id) {
            return result;
        }
        self.value(id)
    }

    /// Object validation: keys must arrive in schema order with no
    /// duplicates, no drops, and no rewrites, or the scan defers.
    #[allow(
        clippy::too_many_lines,
        reason = "one loop over input entries; splitting the key dispatch harms readability"
    )]
    fn object(&mut self, id: NodeId) -> bool {
        let PlanNode::Object {
            keys,
            values,
            mode,
            catchall,
            ..
        } = self.node(id)
        else {
            return false;
        };
        let mode = *mode;
        let catchall = *catchall;
        if keys.len() > 128 || self.depth >= MAX_DEPTH {
            self.dirty_hint = true;
            return false;
        }
        let obj_dispatch = &self.dispatch(id).object;
        if self.peek() != Some(b'{') {
            return false;
        }
        self.depth += 1;
        self.i += 1;
        self.ws();
        let mut seen: u128 = 0;
        let mut last_schema_i: Option<usize> = None;
        let mut seen_catchall = false;
        let mut ok = true;
        if self.peek() == Some(b'}') {
            self.i += 1;
        } else {
            'entries: loop {
                self.ws();
                if self.dirty_hint {
                    self.depth -= 1;
                    return true;
                }
                let Some(k) = self.key_token() else {
                    // Escaped or malformed key: the DOM walk decides.
                    self.dirty_hint = true;
                    ok = false;
                    break;
                };
                self.ws();
                if self.peek() != Some(b':') {
                    ok = false;
                    break;
                }
                self.i += 1;
                self.ws();
                if let Some(schema_i) = obj_dispatch.as_ref().and_then(|o| o.find_bytes(k)) {
                    // Duplicates and out-of-order keys are reordered or
                    // collapsed on rewrite: the object validates dirty.
                    if last_schema_i.is_some_and(|l| schema_i <= l) {
                        self.dirty_hint = true;
                        self.depth -= 1;
                        return true;
                    }
                    if seen_catchall {
                        self.dirty_hint = true;
                        self.depth -= 1;
                        return true;
                    }
                    last_schema_i = Some(schema_i);
                    seen |= 1 << schema_i;
                    if !self.field(values[schema_i]) {
                        ok = false;
                        break;
                    }
                } else if k == b"__proto__" {
                    // Dropped on output: validates dirty.
                    self.dirty_hint = true;
                    self.depth -= 1;
                    return true;
                } else if let Some(catchall_id) = catchall {
                    seen_catchall = true;
                    if !self.value(catchall_id) {
                        ok = false;
                        break;
                    }
                } else if matches!(mode, crate::plan::ObjectMode::Strict) {
                    // unrecognized_keys is a hard failure.
                    ok = false;
                    break;
                } else {
                    // strip/passthrough rewrite the output: validates dirty.
                    self.dirty_hint = true;
                    self.depth -= 1;
                    return true;
                }
                self.ws();
                match self.peek() {
                    Some(b',') => {
                        self.i += 1;
                    }
                    Some(b'}') => {
                        self.i += 1;
                        break 'entries;
                    }
                    _ => {
                        ok = false;
                        break 'entries;
                    }
                }
            }
        }
        self.depth -= 1;
        if !ok {
            return false;
        }
        // Absent schema keys: a default/prefault/catch value materializes on
        // rewrite (validates dirty); anything else is a hard missing-input
        // failure.
        for (schema_i, _) in keys.iter().enumerate() {
            if seen & (1 << schema_i) == 0 {
                if crate::validate::has_default(self.plan, values[schema_i]) {
                    self.dirty_hint = true;
                    return true;
                }
                return false;
            }
        }
        true
    }

    /// Array validation with its length checks.
    fn array(&mut self, id: NodeId, element: NodeId) -> bool {
        if self.peek() != Some(b'[') {
            return false;
        }
        self.i += 1;
        self.ws();
        let mut len: usize = 0;
        if self.peek() == Some(b']') {
            self.i += 1;
        } else {
            loop {
                self.ws();
                if self.dirty_hint {
                    return true;
                }
                if !self.value(element) {
                    return false;
                }
                len += 1;
                self.ws();
                match self.peek() {
                    Some(b',') => {
                        self.i += 1;
                    }
                    Some(b']') => {
                        self.i += 1;
                        break;
                    }
                    _ => return false,
                }
            }
        }
        let PlanNode::Array { checks, .. } = self.node(id) else {
            return false;
        };
        #[allow(
            clippy::cast_precision_loss,
            reason = "collection lengths compared against small numeric bounds"
        )]
        let len_f = len as f64;
        for check in checks {
            let ok = match check {
                Check::MinLength { v } | Check::MinSize { v } => len_f >= *v,
                Check::MaxLength { v } | Check::MaxSize { v } => len_f <= *v,
                Check::Length { v } | Check::Size { v } => {
                    len_f.partial_cmp(v) == Some(std::cmp::Ordering::Equal)
                }
                _ => true,
            };
            if !ok {
                return false;
            }
        }
        true
    }

    /// Tuple validation. Fully-present inputs scan; any absent slot defers to
    /// the DOM walk's optional-tail machinery.
    fn tuple(&mut self, id: NodeId) -> bool {
        let PlanNode::Tuple { items, rest } = self.node(id) else {
            return false;
        };
        let rest = *rest;
        if self.depth >= MAX_DEPTH {
            self.dirty_hint = true;
            return false;
        }
        self.depth += 1;
        let mut ok = true;
        if self.peek() != Some(b'[') {
            self.depth -= 1;
            return false;
        }
        self.i += 1;
        self.ws();
        let mut len: usize = 0;
        if self.peek() == Some(b']') {
            self.i += 1;
        } else {
            loop {
                self.ws();
                if len < items.len() {
                    if !self.value(items[len]) {
                        ok = false;
                        break;
                    }
                } else if let Some(rest_id) = rest {
                    if !self.value(rest_id) {
                        ok = false;
                        break;
                    }
                } else {
                    // Overlong with no rest schema: canonical `too_big`.
                    ok = false;
                    break;
                }
                len += 1;
                self.ws();
                match self.peek() {
                    Some(b',') => {
                        self.i += 1;
                    }
                    Some(b']') => {
                        self.i += 1;
                        break;
                    }
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
        }
        self.depth -= 1;
        if !ok {
            return false;
        }
        if len < items.len() {
            // Absent slots run the DOM walk's default/catch/optional-tail
            // machinery: the tuple may validate with a rewrite (dropped tail
            // or filled default) or fail — the scan cannot tell cheaply.
            self.dirty_hint = true;
            return false;
        }
        true
    }

    /// Discriminated union: pre-scan the object for the discriminant's
    /// last-wins value, dispatch, then validate from the object's start.
    fn disc_union(&mut self, id: NodeId, disc_key: &str) -> bool {
        if self.peek() != Some(b'{') {
            return false;
        }
        let mark = self.i;
        self.i += 1;
        self.ws();
        let mut disc: Option<NodeId> = None;
        let mut ok = true;
        if self.peek() == Some(b'}') {
            self.i += 1;
        } else {
            'entries: loop {
                self.ws();
                let Some(k) = self.key_token() else {
                    ok = false;
                    break;
                };
                self.ws();
                if self.peek() != Some(b':') {
                    ok = false;
                    break;
                }
                self.i += 1;
                self.ws();
                if k == disc_key.as_bytes() {
                    // Last matching key wins, mirroring the collapse.
                    match self.disc_literal(id) {
                        Some(node) => disc = Some(node),
                        None => {
                            // Not a dispatchable literal, or an unlisted
                            // value: skip it; a later duplicate key may
                            // still decide.
                            if !self.skip_value() {
                                ok = false;
                                break;
                            }
                        }
                    }
                } else if !self.skip_value() {
                    ok = false;
                    break;
                }
                self.ws();
                match self.peek() {
                    Some(b',') => {
                        self.i += 1;
                    }
                    Some(b'}') => {
                        self.i += 1;
                        break 'entries;
                    }
                    _ => {
                        ok = false;
                        break 'entries;
                    }
                }
            }
        }
        let Some(target) = disc else {
            return false;
        };
        if !ok {
            return false;
        }
        self.i = mark;
        self.value(target)
    }

    /// Parses the discriminant literal at the cursor and looks up its option.
    /// The cursor is left untouched on any parse ambiguity.
    fn disc_literal(&mut self, id: NodeId) -> Option<NodeId> {
        let dispatch = self.dispatch(id).disc_union.as_ref()?;
        let mark = self.i;
        let found = match self.peek()? {
            b'"' => {
                let s = self.string_token()?;
                dispatch.find_str(s)
            }
            b't' => {
                if self.eat(b"true") {
                    dispatch.find_bool(true)
                } else {
                    None
                }
            }
            b'f' => {
                if self.eat(b"false") {
                    dispatch.find_bool(false)
                } else {
                    None
                }
            }
            b'n' => {
                if self.eat(b"null") {
                    dispatch.find_null()
                } else {
                    None
                }
            }
            _ => self.number_token().and_then(|n| dispatch.find_number(n)),
        };
        if found.is_none() {
            self.i = mark;
        }
        found
    }

    /// Record validation: key schemas validated inline, last-wins duplicates
    /// and `__proto__` defer.
    fn record(&mut self, id: NodeId) -> bool {
        let PlanNode::Record { key, value: val } = self.node(id) else {
            return false;
        };
        let (key_id, val_id) = (*key, *val);
        let string_key = matches!(self.node(key_id), PlanNode::String { .. });
        if self.depth >= MAX_DEPTH {
            self.dirty_hint = true;
            return false;
        }
        self.depth += 1;
        let mut ok = true;
        if self.peek() != Some(b'{') {
            self.depth -= 1;
            return false;
        }
        self.i += 1;
        self.ws();
        let mut entries: SmallVec<[&'a [u8]; 16]> = SmallVec::new();
        if self.peek() == Some(b'}') {
            self.i += 1;
        } else {
            'entries: loop {
                self.ws();
                let Some(k) = self.key_token() else {
                    ok = false;
                    break;
                };
                self.ws();
                if self.peek() != Some(b':') {
                    ok = false;
                    break;
                }
                self.i += 1;
                self.ws();
                if k == b"__proto__" {
                    // Dropped key rewrites the input: the record validates dirty.
                    self.dirty_hint = true;
                    self.depth -= 1;
                    return true;
                }
                if entries.contains(&k) {
                    // Duplicate key collapsed to last-wins: validates dirty.
                    self.dirty_hint = true;
                    self.depth -= 1;
                    return true;
                }
                // Bound the quadratic duplicate check. Beyond 128 entries the
                // scan would cost O(n^2) on its zero-alloc hot path (see
                // object() which already defers when keys.len() > 128). Large
                // clean records defer to the DOM walk, which collapses via
                // HashMap O(n) and remains correct.
                if entries.len() >= 128 {
                    self.dirty_hint = true;
                    self.depth -= 1;
                    return true;
                }
                entries.push(k);
                if string_key {
                    // Key checks need the decoded text; invalid UTF-8 defers
                    // to the DOM walk (whose sonic parse rejects the input).
                    let Some(ks) = std::str::from_utf8(k).ok() else {
                        self.dirty_hint = true;
                        ok = false;
                        break;
                    };
                    if !self.string_checks(key_id, ks) {
                        ok = false;
                        break;
                    }
                } else {
                    // Non-string record key schemas: the DOM walk owns them.
                    self.dirty_hint = true;
                    ok = false;
                    break;
                }
                if !self.value(val_id) {
                    ok = false;
                    break;
                }
                self.ws();
                match self.peek() {
                    Some(b',') => {
                        self.i += 1;
                    }
                    Some(b'}') => {
                        self.i += 1;
                        break 'entries;
                    }
                    _ => {
                        ok = false;
                        break 'entries;
                    }
                }
            }
        }
        self.depth -= 1;
        ok
    }
}

/// Numeric format bounds, mirroring the DOM walk's `number_format`.
fn number_format_scan(fmt: crate::plan::NumberFormat, n: f64) -> bool {
    use crate::plan::NumberFormat;
    if matches!(
        fmt,
        NumberFormat::Int32 | NumberFormat::Uint32 | NumberFormat::Safeint
    ) && (n.fract() != 0.0 || !n.is_finite() || n.abs() > MAX_SAFE_INT)
    {
        return false;
    }
    let (min, max) = number_format_range(fmt);
    n >= min && n <= max
}
