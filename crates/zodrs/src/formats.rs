//! String format validators.
//!
//! The regex-compilable formats are ported verbatim (as behavior spec) from
//! `.references/zod/packages/zod/src/v4/core/regexes.ts`, with JS anchors
//! rewritten to Rust's absolute `\A … \z` so a whole-string match matches JS
//! `^…$` without the `m` flag. The four lookaround formats — the default
//! `email`, `duration`, `extendedDuration`, and `hostname` — get hand-written
//! linear-time scanners derived from the regexes' accept/reject behavior; no
//! backtracking engine touches untrusted input.
//!
//! ISO `date` / `datetime` additionally cross-check the calendar date through
//! `jiff` after the shape match (the shape regex already encodes leap-year and
//! month-length rules, so this only ever agrees).

use regex::Regex;
use serde_json::Value as Json;

/// A compiled format validator plus the canonical format id used in the
/// `format` field of an `invalid_format` issue.
#[derive(Debug)]
pub struct FormatValidator {
    /// Canonical format id used in the `format` field of an issue.
    pub id: String,
    kind: Kind,
}

#[derive(Debug)]
enum Kind {
    Rx(Regex),
    /// Regex shape check plus a jiff calendar-date cross-check.
    IsoDate(Regex),
    IsoDateTime(Regex),
    Email,
    Duration,
    ExtDuration,
    Hostname,
}

impl FormatValidator {
    /// Validates a string against this format.
    #[must_use]
    pub fn is_valid(&self, s: &str) -> bool {
        match &self.kind {
            Kind::Rx(r) => r.is_match(s),
            Kind::IsoDate(r) => r.is_match(s) && jiff_date_ok(s),
            Kind::IsoDateTime(r) => {
                if !r.is_match(s) {
                    return false;
                }
                // Cross-check the date portion (before 'T') via jiff.
                match s.split_once(['T', 't']) {
                    Some((date, _)) => jiff_date_ok(date),
                    None => false,
                }
            }
            Kind::Email => email_default(s),
            Kind::Duration => duration_8601_1(s),
            Kind::ExtDuration => duration_8601_2(s),
            Kind::Hostname => hostname(s),
        }
    }
}

fn jiff_date_ok(date: &str) -> bool {
    date.parse::<jiff::civil::Date>().is_ok()
}

/// Wrap a Rust regex body so it matches the whole haystack, JS `^…$`-style.
fn anchored(body: &str) -> String {
    format!(r"\A(?:{body})\z")
}

fn rx(id: &str, body: &str) -> Result<FormatValidator, String> {
    Regex::new(&anchored(body))
        .map(|r| FormatValidator {
            id: id.to_string(),
            kind: Kind::Rx(r),
        })
        .map_err(|e| format!("format {id}: {e}"))
}

// Bodies (no anchors) ported from regexes.ts.
const GUID: &str =
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_ANY: &str = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff";
const CUID: &str = r"[cC][0-9a-z]{6,}";
const CUID2: &str = r"[0-9a-z]+";
const ULID: &str = r"[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}";
const XID: &str = r"[0-9a-vA-V]{20}";
const KSUID: &str = r"[A-Za-z0-9]{27}";
const NANOID: &str = r"[a-zA-Z0-9_-]{21}";
const HTML5_EMAIL: &str = r"[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*";
const RFC5322_EMAIL: &str = r#"(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))"#;
const UNICODE_EMAIL: &str = r#"[^\s@"]{1,64}@[^\s@]{1,255}"#;
const IPV4: &str = r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const IPV6: &str = r"([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)";
const MAC: &str =
    r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}";
const CIDRV4: &str = r"((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])/([0-9]|[1-2][0-9]|3[0-2])";
const CIDRV6: &str = r"(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))/(12[0-8]|1[01][0-9]|[1-9]?[0-9])";
const BASE64: &str =
    r"(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?";
const BASE64URL: &str = r"[A-Za-z0-9_-]*";
const E164: &str = r"\+[1-9]\d{6,14}";
const HEX: &str = r"[0-9a-fA-F]*";
const LOWERCASE: &str = r"[^A-Z]*";
const UPPERCASE: &str = r"[^a-z]*";
const EMOJI: &str = r"(\p{Extended_Pictographic}|\p{Emoji_Component})+";
const DATE_SOURCE: &str = r"(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))";
// JWT: three base64url segments separated by dots (header.payload.signature).
const JWT: &str = r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+";

fn time_source(precision: Option<i64>) -> String {
    let hhmm = r"(?:[01]\d|2[0-3]):[0-5]\d";
    match precision {
        Some(-1) => hhmm.to_string(),
        Some(0) => format!(r"{hhmm}:[0-5]\d"),
        Some(p) if p > 0 => format!(r"{hhmm}:[0-5]\d\.\d{{{p}}}"),
        _ => format!(r"{hhmm}(?::[0-5]\d(?:\.\d+)?)?"),
    }
}

fn params_i64(params: Option<&Json>, key: &str) -> Option<i64> {
    params?.get(key)?.as_i64()
}
fn params_bool(params: Option<&Json>, key: &str) -> bool {
    params
        .and_then(|p| p.get(key))
        .and_then(Json::as_bool)
        .unwrap_or(false)
}

/// Compiles a named string format.
///
/// # Errors
///
/// Returns an error string when the format id is unknown or its regex fails to
/// compile; either outcome poisons JSON eligibility.
pub fn compile(id: &str, params: Option<&Json>) -> Result<FormatValidator, String> {
    match id {
        // hand-written scanners
        "email" => Ok(FormatValidator {
            id: id.to_string(),
            kind: Kind::Email,
        }),
        "duration" => Ok(FormatValidator {
            id: id.to_string(),
            kind: Kind::Duration,
        }),
        "extendedDuration" | "extended_duration" => Ok(FormatValidator {
            id: id.to_string(),
            kind: Kind::ExtDuration,
        }),
        "hostname" => Ok(FormatValidator {
            id: id.to_string(),
            kind: Kind::Hostname,
        }),

        // email pattern variants (regex-compilable)
        "html5Email" | "html5_email" => rx(id, HTML5_EMAIL),
        "rfc5322Email" | "rfc5322_email" => rx(id, RFC5322_EMAIL),
        "unicodeEmail" | "unicode_email" | "idnEmail" | "idn_email" => rx(id, UNICODE_EMAIL),

        "guid" => rx(id, GUID),
        "uuid" => rx(id, UUID_ANY),
        "uuidv4" | "uuid4" => rx(id, r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"),
        "uuidv6" | "uuid6" => rx(id, r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"),
        "uuidv7" | "uuid7" => rx(id, r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"),
        "cuid" => rx(id, CUID),
        "cuid2" => rx(id, CUID2),
        "ulid" => rx(id, ULID),
        "xid" => rx(id, XID),
        "ksuid" => rx(id, KSUID),
        "nanoid" => rx(id, NANOID),
        "ipv4" => rx(id, IPV4),
        "ipv6" => rx(id, IPV6),
        "mac" => rx(id, MAC),
        "cidrv4" => rx(id, CIDRV4),
        "cidrv6" => rx(id, CIDRV6),
        "base64" => rx(id, BASE64),
        "base64url" => rx(id, BASE64URL),
        "e164" => rx(id, E164),
        "hex" => rx(id, HEX),
        "lowercase" => rx(id, LOWERCASE),
        "uppercase" => rx(id, UPPERCASE),
        "emoji" => rx(id, EMOJI),
        "jwt" => rx(id, JWT),

        "date" => Regex::new(&anchored(DATE_SOURCE))
            .map(|r| FormatValidator {
                id: id.to_string(),
                kind: Kind::IsoDate(r),
            })
            .map_err(|e| format!("format date: {e}")),

        "time" => {
            let body = time_source(params_i64(params, "precision"));
            rx(id, &body)
        }

        "datetime" => {
            let time = time_source(params_i64(params, "precision"));
            let mut opts: Vec<String> = vec!["Z".to_string()];
            if params_bool(params, "local") {
                opts.push(String::new());
            }
            if params_bool(params, "offset") {
                opts.push(r"([+-](?:[01]\d|2[0-3]):[0-5]\d)".to_string());
            }
            let body = format!("{DATE_SOURCE}T(?:{}(?:{}))", time, opts.join("|"));
            Regex::new(&anchored(&body))
                .map(|r| FormatValidator {
                    id: id.to_string(),
                    kind: Kind::IsoDateTime(r),
                })
                .map_err(|e| format!("format datetime: {e}"))
        }

        // hash families (hex / base64 / base64url with fixed lengths + padding)
        "md5_hex" => rx(id, r"[0-9a-fA-F]{32}"),
        "md5_base64" => rx(id, r"[A-Za-z0-9+/]{22}=="),
        "md5_base64url" => rx(id, r"[A-Za-z0-9_-]{22}"),
        "sha1_hex" => rx(id, r"[0-9a-fA-F]{40}"),
        "sha1_base64" => rx(id, r"[A-Za-z0-9+/]{27}="),
        "sha1_base64url" => rx(id, r"[A-Za-z0-9_-]{27}"),
        "sha256_hex" => rx(id, r"[0-9a-fA-F]{64}"),
        "sha256_base64" => rx(id, r"[A-Za-z0-9+/]{43}="),
        "sha256_base64url" => rx(id, r"[A-Za-z0-9_-]{43}"),
        "sha384_hex" => rx(id, r"[0-9a-fA-F]{96}"),
        "sha384_base64" => rx(id, r"[A-Za-z0-9+/]{64}"),
        "sha384_base64url" => rx(id, r"[A-Za-z0-9_-]{64}"),
        "sha512_hex" => rx(id, r"[0-9a-fA-F]{128}"),
        "sha512_base64" => rx(id, r"[A-Za-z0-9+/]{86}=="),
        "sha512_base64url" => rx(id, r"[A-Za-z0-9_-]{86}"),

        other => Err(format!("unknown format id: {other}")),
    }
}

// ------------------------------------------------------------------------
// Hand-written linear scanners for the lookaround formats.
// ------------------------------------------------------------------------

/// `regexes.email` (default): local part with no leading dot, no `..`, ending
/// in an unrestricted char, `@`, then a dotted domain ending in a 2+ letter TLD.
fn email_default(s: &str) -> bool {
    let Some(at) = s.find('@') else { return false };
    // Only one '@' is possible: neither local nor domain char classes admit it.
    if s[at + 1..].contains('@') {
        return false;
    }
    let local = &s[..at];
    let domain = &s[at + 1..];
    email_local_ok(local) && email_domain_ok(domain)
}

fn email_local_ok(local: &str) -> bool {
    // `([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]`, plus `(?!\.)` and `(?!.*\.\.)`.
    if local.is_empty() || local.starts_with('.') || local.contains("..") {
        return false;
    }
    let bytes = local.as_bytes();
    let last = bytes[bytes.len() - 1];
    // Final char class excludes '.' and '\''.
    if !(last.is_ascii_alphanumeric() || matches!(last, b'_' | b'+' | b'-')) {
        return false;
    }
    // Every char in the broad local class.
    bytes.iter().all(|&c| {
        c.is_ascii_alphanumeric() || matches!(c, b'_' | b'\'' | b'+' | b'-' | b'.')
    })
}

fn email_domain_ok(domain: &str) -> bool {
    // `([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}`
    let parts: Vec<&str> = domain.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let Some((tld, labels)) = parts.split_last() else {
        return false;
    };
    // TLD: 2+ ASCII letters.
    if tld.len() < 2 || !tld.bytes().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    labels.iter().all(|label| {
        let b = label.as_bytes();
        !b.is_empty()
            && b[0].is_ascii_alphanumeric()
            && b[1..].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'-')
    })
}

/// `regexes.hostname`: 1..253 chars (ignoring one optional trailing dot),
/// dot-separated labels of 1..63 chars each starting and ending alphanumeric.
fn hostname(s: &str) -> bool {
    let core = s.strip_suffix('.').unwrap_or(s);
    if core.is_empty() || core.len() > 253 {
        return false;
    }
    core.split('.').all(|label| {
        let b = label.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && b[0].is_ascii_alphanumeric()
            && b[b.len() - 1].is_ascii_alphanumeric()
            && b.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'-')
    })
}

/// ISO 8601-1 duration (`regexes.duration`): `P` then either `\d+W`, or a
/// weeks-free sequence of optional Y/M/D and an optional `T` time section.
fn duration_8601_1(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('P') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    // Branch (a): pure weeks, `\d+W`.
    if let Some(weeks) = rest.strip_suffix('W') {
        return !weeks.is_empty() && weeks.bytes().all(|c| c.is_ascii_digit());
    }
    // Branch (b): no 'W' allowed.
    if rest.contains('W') {
        return false;
    }
    let b = rest.as_bytes();
    let mut i = 0usize;
    let mut matched = false;
    for unit in *b"YMD" {
        if take_uint_unit(b, &mut i, unit) {
            matched = true;
        }
    }
    if i < b.len() && b[i] == b'T' {
        i += 1;
        // `(?=\d)`: a digit must immediately follow 'T'.
        let mut t_matched = false;
        if take_uint_unit(b, &mut i, b'H') {
            t_matched = true;
        }
        if take_uint_unit(b, &mut i, b'M') {
            t_matched = true;
        }
        if take_seconds_unit(b, &mut i) {
            t_matched = true;
        }
        if !t_matched {
            return false;
        }
        matched = true;
    }
    matched && i == b.len()
}

/// Consume `\d+<unit>` at `*i` if present; advance and return true on success.
fn take_uint_unit(b: &[u8], i: &mut usize, unit: u8) -> bool {
    let start = *i;
    let mut j = *i;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j > start && j < b.len() && b[j] == unit {
        *i = j + 1;
        true
    } else {
        false
    }
}

/// Consume `\d+([.,]\d+)?S` at `*i` if present.
fn take_seconds_unit(b: &[u8], i: &mut usize) -> bool {
    let start = *i;
    let mut j = *i;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == start {
        return false;
    }
    if j < b.len() && (b[j] == b'.' || b[j] == b',') {
        let frac_start = j + 1;
        let mut k = frac_start;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k == frac_start {
            return false;
        }
        j = k;
    }
    if j < b.len() && b[j] == b'S' {
        *i = j + 1;
        true
    } else {
        false
    }
}

/// ISO 8601-2 extended duration (`regexes.extendedDuration`): optional sign,
/// `P`, then signed/optionally-fractional Y/M/W/D and a signed `T` section. A
/// fractional component must be the final component.
fn duration_8601_2(s: &str) -> bool {
    let rest = s
        .strip_prefix(['-', '+'])
        .unwrap_or(s);
    let Some(rest) = rest.strip_prefix('P') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let b = rest.as_bytes();
    let mut i = 0usize;
    let mut matched = false;

    for unit in *b"YMWD" {
        match take_ext_component(b, &mut i, unit) {
            Comp::Int => matched = true,
            Comp::Frac => {
                // Fractional component must end the string.
                return i == b.len();
            }
            Comp::None => {}
        }
    }

    if i < b.len() && b[i] == b'T' {
        i += 1;
        // `(?=[\d+-])`
        if i >= b.len() || !(b[i].is_ascii_digit() || b[i] == b'+' || b[i] == b'-') {
            return false;
        }
        for unit in *b"HM" {
            match take_ext_component(b, &mut i, unit) {
                Comp::Int => matched = true,
                Comp::Frac => return i == b.len(),
                Comp::None => {}
            }
        }
        // Seconds: `[-+]?\d+(?:[.,]\d+)?S`
        if take_ext_seconds(b, &mut i) {
            matched = true;
        }
        matched = matched && i <= b.len();
    }

    matched && i == b.len()
}

enum Comp {
    None,
    Int,
    Frac,
}

/// Consume `[-+]?\d+<unit>` (Int) or `[-+]?\d+[.,]\d+<unit>` (Frac).
fn take_ext_component(b: &[u8], i: &mut usize, unit: u8) -> Comp {
    let start = *i;
    let mut j = *i;
    if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
        j += 1;
    }
    let digits_start = j;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start {
        return Comp::None; // no digits => not this component
    }
    // Optional fractional part.
    if j < b.len() && (b[j] == b'.' || b[j] == b',') {
        let frac_start = j + 1;
        let mut k = frac_start;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k > frac_start && k < b.len() && b[k] == unit {
            *i = k + 1;
            return Comp::Frac;
        }
        // Digits present but not this unit: backtrack, not our component.
        let _ = start;
        return Comp::None;
    }
    if j < b.len() && b[j] == unit {
        *i = j + 1;
        Comp::Int
    } else {
        Comp::None
    }
}

/// Consume `[-+]?\d+(?:[.,]\d+)?S`.
fn take_ext_seconds(b: &[u8], i: &mut usize) -> bool {
    let mut j = *i;
    if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
        j += 1;
    }
    let digits_start = j;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start {
        return false;
    }
    if j < b.len() && (b[j] == b'.' || b[j] == b',') {
        let frac_start = j + 1;
        let mut k = frac_start;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k == frac_start {
            return false;
        }
        j = k;
    }
    if j < b.len() && b[j] == b'S' {
        *i = j + 1;
        true
    } else {
        false
    }
}
