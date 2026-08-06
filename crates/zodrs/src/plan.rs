//! Serializable plan intermediate representation shared by the TypeScript
//! schema builder and the Rust validator.
//!
//! A plan is a flat arena of [`PlanNode`] values referenced by [`NodeId`].
//! Reserving an index before descending lets lazy schemas represent cycles as
//! ordinary back-edges without reference-counted nodes.

use serde::Deserialize;
use serde_json::Value as Json;

/// Index into a plan's flat node arena.
pub type NodeId = u32;

/// A deserialized validation plan.
#[derive(Debug, Clone)]
pub struct RawPlan {
    /// Flat node arena. Every [`NodeId`] indexes this vector.
    pub nodes: Vec<PlanNode>,
    /// Arena index at which validation begins.
    pub root: NodeId,
}

impl RawPlan {
    /// Parses a plan from its JSON wire form.
    ///
    /// The canonical form is a bare node array whose root is index zero. The
    /// wrapped `{ "nodes": [...], "root": N }` form is also accepted for Rust
    /// callers that need a non-zero root.
    ///
    /// # Errors
    ///
    /// Returns a [`serde_json::Error`] when the JSON is malformed or does not
    /// conform to the plan IR.
    pub fn from_json(s: &str) -> Result<RawPlan, serde_json::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Wrapped {
                nodes: Vec<PlanNode>,
                #[serde(default)]
                root: NodeId,
            },
            Bare(Vec<PlanNode>),
        }
        Ok(match serde_json::from_str::<Wire>(s)? {
            Wire::Wrapped { nodes, root } => RawPlan { nodes, root },
            Wire::Bare(nodes) => RawPlan { nodes, root: 0 },
        })
    }
}

/// Policy for object keys absent from the schema shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectMode {
    /// Drop unknown keys from the output.
    Strip,
    /// Reject unknown keys with an `unrecognized_keys` issue.
    Strict,
    /// Preserve unknown keys in the output.
    Passthrough,
}

/// A schema operation in the flat plan arena.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "k")]
pub enum PlanNode {
    /// Validates a string and applies string checks.
    #[serde(rename = "string")]
    String {
        /// Checks applied in declaration order.
        #[serde(default)]
        checks: Vec<Check>,
        /// Whether JSON scalars are converted with JavaScript string semantics.
        #[serde(default)]
        coerce: bool,
    },
    /// Validates a number and applies numeric checks.
    #[serde(rename = "number")]
    Number {
        /// Checks applied in declaration order.
        #[serde(default)]
        checks: Vec<Check>,
        /// Whether strings and booleans are converted to numbers.
        #[serde(default)]
        coerce: bool,
    },
    /// Represents a JavaScript bigint schema.
    #[serde(rename = "bigint")]
    BigInt {
        /// Range, format, and divisibility checks.
        #[serde(default)]
        checks: Vec<Check>,
        /// Whether JSON strings or numbers are accepted as bigint inputs.
        #[serde(default)]
        coerce: bool,
    },
    /// Represents a JavaScript `Date` schema.
    #[serde(rename = "date")]
    Date {
        /// Date range checks expressed as epoch-millisecond bounds.
        #[serde(default)]
        checks: Vec<Check>,
        /// Whether JSON strings or numbers are accepted as date inputs.
        #[serde(default)]
        coerce: bool,
    },
    /// Represents a host `File` value, which JSON cannot materialize.
    #[serde(rename = "file")]
    File {
        /// Size, MIME, and property checks.
        #[serde(default)]
        checks: Vec<Check>,
    },

    /// Validates a boolean.
    #[serde(rename = "boolean")]
    Boolean {
        /// Whether JSON values are converted with JavaScript boolean semantics.
        #[serde(default)]
        coerce: bool,
    },
    /// Accepts only JSON null.
    #[serde(rename = "null")]
    Null,
    /// Accepts only JavaScript `undefined`, which JSON cannot represent.
    #[serde(rename = "undefined")]
    Undefined,
    /// Accepts every value.
    #[serde(rename = "any")]
    Any,
    /// Accepts every value while preserving an unknown output type.
    #[serde(rename = "unknown")]
    Unknown,
    /// Rejects every value.
    #[serde(rename = "never")]
    Never,
    /// Accepts JavaScript `undefined` as a void value.
    #[serde(rename = "void")]
    Void,
    /// Accepts a JavaScript symbol, which JSON cannot represent.
    #[serde(rename = "symbol")]
    Symbol,
    /// Accepts JavaScript `NaN`, which JSON cannot represent.
    #[serde(rename = "nan")]
    Nan,

    /// Accepts one of a fixed set of primitive values.
    #[serde(rename = "literal")]
    Literal {
        /// Allowed string, number, boolean, or null values.
        values: Vec<Json>,
    },
    /// Accepts one of a fixed set of string or number enum values.
    #[serde(rename = "enum")]
    Enum {
        /// Allowed enum values.
        values: Vec<Json>,
    },

    /// Validates an object shape.
    #[serde(rename = "object")]
    Object {
        /// Shape keys in canonical output order.
        keys: Vec<String>,
        /// Child schema index corresponding to each key.
        values: Vec<NodeId>,
        /// Whether each shape key may be absent.
        optional: Vec<bool>,
        /// Unknown-key policy when no catchall is present.
        mode: ObjectMode,
        /// Schema applied to unknown values, if any.
        #[serde(default)]
        catchall: Option<NodeId>,
    },
    /// Validates a homogeneous array.
    #[serde(rename = "array")]
    Array {
        /// Schema applied to every array element.
        element: NodeId,
        /// Length checks applied to the array.
        #[serde(default)]
        checks: Vec<Check>,
    },
    /// Validates a positional tuple.
    #[serde(rename = "tuple")]
    Tuple {
        /// Schema for each required tuple position.
        items: Vec<NodeId>,
        /// Schema for positions beyond `items`, if allowed.
        #[serde(default)]
        rest: Option<NodeId>,
    },
    /// Accepts the first successful option.
    #[serde(rename = "union")]
    Union {
        /// Candidate schema indices in evaluation order.
        options: Vec<NodeId>,
    },
    /// Dispatches an object union by a primitive property value.
    #[serde(rename = "discunion")]
    DiscUnion {
        /// Object property used as the discriminant.
        key: String,
        /// Mapping from discriminant literals to option schemas.
        map: Vec<(Json, NodeId)>,
    },
    /// Requires both child schemas to succeed.
    #[serde(rename = "intersection")]
    Intersection {
        /// Left-hand schema.
        left: NodeId,
        /// Right-hand schema.
        right: NodeId,
    },
    /// Validates every key and value in a JSON object.
    #[serde(rename = "record")]
    Record {
        /// Schema applied to string keys.
        key: NodeId,
        /// Schema applied to property values.
        value: NodeId,
    },
    /// Represents a JavaScript `Map`, which JSON cannot materialize directly.
    #[serde(rename = "map")]
    Map {
        /// Optional schema applied to map keys.
        #[serde(default)]
        key: Option<NodeId>,
        /// Schema applied to map values.
        value: NodeId,
        /// Size checks applied to the map.
        #[serde(default)]
        checks: Vec<Check>,
    },
    /// Represents a JavaScript `Set`, which JSON cannot materialize directly.
    #[serde(rename = "set")]
    Set {
        /// Schema applied to set elements.
        value: NodeId,
        /// Size checks applied to the set.
        #[serde(default)]
        checks: Vec<Check>,
    },

    /// Accepts an absent value or delegates to `inner`.
    #[serde(rename = "optional")]
    Optional {
        /// Schema used when a value is present.
        inner: NodeId,
    },
    /// Accepts null or delegates to `inner`.
    #[serde(rename = "nullable")]
    Nullable {
        /// Schema used when the value is not null.
        inner: NodeId,
    },
    /// Delegates to `inner` but rejects absence.
    #[serde(rename = "nonoptional")]
    NonOptional {
        /// Wrapped schema.
        inner: NodeId,
    },
    /// Delegates validation to `inner` and marks the JS output readonly.
    #[serde(rename = "readonly")]
    Readonly {
        /// Wrapped schema.
        inner: NodeId,
    },
    /// Resolves a lazily declared schema, including arena back-edges.
    #[serde(rename = "lazy")]
    Lazy {
        /// Resolved schema index.
        inner: NodeId,
    },
    /// Represents a host promise schema; async execution stays in TypeScript.
    #[serde(rename = "promise")]
    Promise {
        /// Schema for the resolved value.
        inner: NodeId,
    },

    /// Supplies a value when the input is absent.
    #[serde(rename = "default")]
    Default {
        /// Schema applied to present values.
        inner: NodeId,
        /// Static JSON default; null when dynamic.
        #[serde(default)]
        value: Json,
        /// Whether the default comes from a host closure.
        #[serde(default)]
        dynamic: bool,
    },
    /// Supplies an input value before validating an absent value.
    #[serde(rename = "prefault")]
    Prefault {
        /// Schema applied after inserting the prefault.
        inner: NodeId,
        /// Static JSON prefault; null when dynamic.
        #[serde(default)]
        value: Json,
        /// Whether the prefault comes from a host closure.
        #[serde(default)]
        dynamic: bool,
    },
    /// Replaces a failed parse with a fallback value.
    #[serde(rename = "catch")]
    Catch {
        /// Schema attempted before using the fallback.
        inner: NodeId,
        /// Static JSON fallback; null when dynamic.
        #[serde(default)]
        value: Json,
        /// Whether the fallback comes from a host closure.
        #[serde(default)]
        dynamic: bool,
    },

    /// Feeds the successful output of schema `a` into schema `b`.
    #[serde(rename = "pipe")]
    Pipe {
        /// Input-side schema.
        a: NodeId,
        /// Output-side schema.
        b: NodeId,
    },
    /// Validates a string against a compiled template-literal pattern.
    #[serde(rename = "templateLiteral")]
    TemplateLiteral {
        /// Rust-regex-compatible pattern emitted by the planner.
        pattern: String,
    },
    /// Represents a JavaScript callback and poisons JSON eligibility.
    #[serde(rename = "host")]
    Host {
        /// Optional schema wrapped by the callback.
        #[serde(default)]
        inner: Option<NodeId>,
        /// Index into the TypeScript plan's host-function table.
        #[serde(rename = "fn")]
        func: u32,
    },
}

/// A built-in validation check attached to a plan node.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "c")]
pub enum Check {
    /// Requires a string or array length at least `v`.
    #[serde(rename = "min_length")]
    MinLength {
        /// Inclusive minimum length.
        v: f64,
    },
    /// Requires a string or array length at most `v`.
    #[serde(rename = "max_length")]
    MaxLength {
        /// Inclusive maximum length.
        v: f64,
    },
    /// Requires an exact string or array length.
    #[serde(rename = "length")]
    Length {
        /// Required length.
        v: f64,
    },
    /// Requires a collection size at least `v`.
    #[serde(rename = "min_size")]
    MinSize {
        /// Inclusive minimum size.
        v: f64,
    },
    /// Requires a collection size at most `v`.
    #[serde(rename = "max_size")]
    MaxSize {
        /// Inclusive maximum size.
        v: f64,
    },
    /// Requires an exact collection size.
    #[serde(rename = "size")]
    Size {
        /// Required size.
        v: f64,
    },

    /// Requires a numeric value greater than the bound.
    #[serde(rename = "gt")]
    Gt {
        /// Number, decimal bigint string, or date-millisecond bound.
        v: Json,
        /// Whether equality with the bound is accepted.
        inclusive: bool,
        /// Whether the bound and input use bigint semantics.
        #[serde(default)]
        bigint: bool,
    },
    /// Requires a numeric value less than the bound.
    #[serde(rename = "lt")]
    Lt {
        /// Number, decimal bigint string, or date-millisecond bound.
        v: Json,
        /// Whether equality with the bound is accepted.
        inclusive: bool,
        /// Whether the bound and input use bigint semantics.
        #[serde(default)]
        bigint: bool,
    },
    /// Requires exact divisibility by `v`.
    #[serde(rename = "multiple_of")]
    MultipleOf {
        /// Numeric divisor or decimal bigint string.
        v: Json,
    },

    /// Restricts a number to a named numeric representation.
    #[serde(rename = "number_format")]
    NumberFormat {
        /// Required numeric format.
        v: NumberFormat,
    },
    /// Restricts a bigint to a signed or unsigned 64-bit range.
    #[serde(rename = "bigint_format")]
    BigIntFormat {
        /// Required bigint format.
        v: BigIntFormat,
    },

    /// Validates a string with a named built-in format.
    #[serde(rename = "format")]
    Format {
        /// Format identifier, such as `email` or `uuid`.
        v: String,
        /// Format-specific options such as datetime precision.
        #[serde(default)]
        params: Option<Json>,
    },
    /// Validates a string with a caller-provided regular expression.
    #[serde(rename = "regex")]
    Regex {
        /// JavaScript regular-expression source.
        src: String,
        /// JavaScript regular-expression flags.
        flags: String,
    },

    /// Requires a string prefix.
    #[serde(rename = "starts_with")]
    StartsWith {
        /// Required prefix.
        v: String,
    },
    /// Requires a string suffix.
    #[serde(rename = "ends_with")]
    EndsWith {
        /// Required suffix.
        v: String,
    },
    /// Requires a string to contain a substring.
    #[serde(rename = "includes")]
    Includes {
        /// Required substring.
        v: String,
        /// UTF-16 code-unit offset at which the search begins.
        #[serde(default)]
        position: Option<usize>,
    },

    /// Requires the absence of ASCII uppercase letters.
    #[serde(rename = "lowercase")]
    Lowercase,
    /// Requires the absence of ASCII lowercase letters.
    #[serde(rename = "uppercase")]
    Uppercase,

    /// Rewrites a string with a named deterministic operation.
    #[serde(rename = "overwrite")]
    Overwrite {
        /// Rewrite operation.
        op: OverwriteOp,
        /// Unicode normalization form when `op` is `normalize`.
        #[serde(default)]
        form: Option<String>,
    },

    /// Restricts a file to one of the listed MIME types.
    #[serde(rename = "mime")]
    Mime {
        /// Accepted MIME type strings.
        v: Vec<String>,
    },
    /// Validates one property with another plan node.
    #[serde(rename = "property")]
    Property {
        /// Property name.
        key: String,
        /// Schema applied to the property's value.
        node: NodeId,
    },
    /// Executes a JavaScript check and poisons JSON eligibility.
    #[serde(rename = "host")]
    Host {
        /// Index into the TypeScript host-function table.
        #[serde(rename = "fn")]
        func: u32,
    },
}

/// Numeric range and integrality formats supported by number checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NumberFormat {
    /// Signed 32-bit integer.
    Int32,
    /// Unsigned 32-bit integer.
    Uint32,
    /// IEEE-754 single-precision range.
    Float32,
    /// IEEE-754 double-precision range.
    Float64,
    /// JavaScript safe integer.
    Safeint,
}

/// Range formats supported by bigint checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BigIntFormat {
    /// Signed 64-bit integer.
    Int64,
    /// Unsigned 64-bit integer.
    Uint64,
}

/// Deterministic string rewrite operations that remain JSON-eligible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum OverwriteOp {
    /// Removes leading and trailing whitespace.
    #[serde(rename = "trim")]
    Trim,
    /// Converts the string to lowercase.
    #[serde(rename = "toLowerCase")]
    ToLowerCase,
    /// Converts the string to uppercase.
    #[serde(rename = "toUpperCase")]
    ToUpperCase,
    /// Normalizes Unicode using the optional `form` field.
    #[serde(rename = "normalize")]
    Normalize,
    /// Converts text to a lowercase hyphen-separated slug.
    #[serde(rename = "slugify")]
    Slugify,
}
