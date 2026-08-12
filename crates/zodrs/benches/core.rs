//! Process-isolated probes for the pure Rust validation core.

use std::borrow::Cow;
use std::env;
use std::hint::black_box;
use std::process::ExitCode;

use smallvec::smallvec;
use sonic_rs::Value as Json;

use zodrs::issue::{Issue, PathSegRef, issues_to_value};
use zodrs::{compile, issues_to_json, validate};

const ORDINARY_PLAN: &str = r#"[{"k":"object","keys":["a","b"],"values":[1,2],"optional":[false,true],"mode":"strip","catchall":null},{"k":"string","checks":[]},{"k":"number","checks":[{"c":"gt","v":0,"inclusive":true}]}]"#;
const ORDINARY_INPUT: &[u8] = br#"{"a":"hello","b":5}"#;

const SIG1_PLAN: &str = include_str!("../tests/testdata/sig1-plan.json");
const SIG1_INPUT: &str = include_str!("../tests/testdata/sig1-input.json");

const COMPILE_DEFAULT: usize = 1000;
const SERIALIZE_ISSUES_DEFAULT: usize = 1000;
const VALIDATE_DEFAULT: usize = 10000;

const EXPECTED_STATUS_0: u8 = 0;
const EXPECTED_STATUS_1: u8 = 1;

#[derive(Debug)]
enum Error {
    Usage,
    Failure(String),
}

impl Error {
    fn code(self) -> u8 {
        match self {
            Error::Usage => 2,
            Error::Failure(_) => 1,
        }
    }
}

impl From<zodrs::CompileError> for Error {
    fn from(err: zodrs::CompileError) -> Self {
        Error::Failure(err.to_string())
    }
}

struct Summary {
    mode: &'static str,
    iterations: usize,
    checksum: u64,
}

fn default_iterations(mode: &str) -> usize {
    match mode {
        "compile" => COMPILE_DEFAULT,
        "serialize-issues" => SERIALIZE_ISSUES_DEFAULT,
        "validate-status0" | "validate-status1" => VALIDATE_DEFAULT,
        _ => 0,
    }
}

fn run() -> Result<Summary, Error> {
    // Cargo appends this runner flag even when the libtest harness is disabled.
    let mut args = env::args().skip(1).filter(|arg| arg != "--bench");
    let mode = args.next().ok_or(Error::Usage)?;

    let iterations: usize = match args.next().as_deref() {
        None => default_iterations(&mode),
        Some(s) => match s.parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => return Err(Error::Usage),
        },
    };

    if args.next().is_some() {
        return Err(Error::Usage);
    }

    match mode.as_str() {
        "compile" => run_compile(iterations),
        "serialize-issues" => Ok(run_serialize_issues(iterations)),
        "validate-status0" => {
            run_validate(ORDINARY_PLAN, ORDINARY_INPUT, EXPECTED_STATUS_0, iterations)
        }
        "validate-status1" => {
            let plan_json = SIG1_PLAN.trim();
            let input = SIG1_INPUT.trim().as_bytes();
            run_validate(plan_json, input, EXPECTED_STATUS_1, iterations)
        }
        _ => Err(Error::Usage),
    }
}

fn run_compile(iterations: usize) -> Result<Summary, Error> {
    let plan_json = SIG1_PLAN.trim();
    let mut checksum: u64 = 0;

    for _ in 0..iterations {
        let compiled = black_box(compile(black_box(plan_json))?);
        checksum = black_box(checksum.wrapping_add(1));
        drop(black_box(compiled));
    }

    Ok(Summary {
        mode: "compile",
        iterations,
        checksum,
    })
}

fn run_serialize_issues(iterations: usize) -> Summary {
    fn path(s: &str) -> zodrs::issue::PathRef<'_> {
        smallvec![PathSegRef::Key(Cow::Borrowed(s))]
    }

    fn index_path(s: &str, i: u32) -> zodrs::issue::PathRef<'_> {
        let mut p = smallvec![PathSegRef::Key(Cow::Borrowed(s))];
        p.push(PathSegRef::Index(i));
        p
    }

    let mut issues = Vec::with_capacity(50);
    for i in 0..50_u32 {
        let p = if i % 2 == 0 {
            path("root")
        } else {
            index_path("items", i)
        };

        let issue = if i % 3 == 0 {
            let nested = vec![
                Issue::new("invalid_type", &path("inner")).with("expected", Json::from("string")),
            ];
            Issue::new("invalid_key", &p)
                .with("origin", Json::from("record"))
                .with("issues", issues_to_value(&nested))
        } else if i % 3 == 1 {
            Issue::new_check("too_small", &p)
                .with("origin", Json::from("array"))
                .with("minimum", Json::from(i64::from(i)))
                .with("inclusive", Json::from(true))
        } else {
            Issue::new("invalid_type", &p)
                .with("expected", Json::from("number"))
                .with("received", Json::from("NaN"))
        };
        issues.push(issue);
    }

    let mut checksum: u64 = 0;

    for _ in 0..iterations {
        let json = black_box(issues_to_json(black_box(&issues)));
        checksum = black_box(checksum.wrapping_add(json.len() as u64));
        drop(black_box(json));
    }

    Summary {
        mode: "serialize-issues",
        iterations,
        checksum,
    }
}

fn run_validate(
    plan_json: &str,
    input: &[u8],
    expected: u8,
    iterations: usize,
) -> Result<Summary, Error> {
    let compiled = compile(plan_json)?;

    let probe = validate(&compiled, input);
    if probe.status != expected {
        return Err(Error::Failure(format!(
            "fixture status drift: expected {expected}, got {}",
            probe.status
        )));
    }

    let mut checksum: u64 = 0;

    for _ in 0..iterations {
        let verdict = black_box(validate(black_box(&compiled), black_box(input)));
        checksum = black_box(
            checksum
                .wrapping_add(u64::from(verdict.status))
                .wrapping_add(1),
        );
        drop(black_box(verdict));
    }

    let mode = match expected {
        0 => "validate-status0",
        1 => "validate-status1",
        _ => "validate",
    };

    Ok(Summary {
        mode,
        iterations,
        checksum,
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(summary) => {
            println!(
                "{{\"mode\":\"{}\",\"iterations\":{},\"checksum\":{}}}",
                summary.mode, summary.iterations, summary.checksum
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            match &err {
                Error::Usage => eprintln!(
                    "usage: core <compile|validate-status0|validate-status1|serialize-issues> [iterations]"
                ),
                Error::Failure(msg) => eprintln!("error: {msg}"),
            }
            ExitCode::from(err.code())
        }
    }
}
