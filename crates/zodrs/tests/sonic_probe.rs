//! Scratch probe of sonic-rs raw behaviors. Temporary.
#![allow(clippy::unwrap_used)]

use sonic_rs::{JsonContainerTrait, JsonValueTrait};

#[test]
fn probe_sonic_behaviors() {
    // 1e400 overflow
    let r = sonic_rs::from_slice::<sonic_rs::Value>(b"1e400");
    println!("1e400 parse: {:?}", r.is_ok());
    if let Ok(v) = &r {
        println!(
            "  is_number={} as_f64={:?} to_string={:?}",
            v.is_number(),
            v.as_f64(),
            sonic_rs::to_string(v)
        );
    }
    // -0
    let v = sonic_rs::from_slice::<sonic_rs::Value>(b"-0").unwrap();
    println!(
        "-0: as_f64={:?} to_string={:?}",
        v.as_f64(),
        sonic_rs::to_string(&v)
    );
    // integers / floats round trip
    for raw in [
        "36",
        "36.0",
        "1e21",
        "9007199254740993",
        "0.30000000000000004",
        "1E2",
        "5e-1",
    ] {
        let v = sonic_rs::from_slice::<sonic_rs::Value>(raw.as_bytes()).unwrap();
        println!(
            "{raw}: to_string={:?} as_f64={:?}",
            sonic_rs::to_string(&v),
            v.as_f64()
        );
    }
    // duplicate keys: iteration order and values
    let v = sonic_rs::from_slice::<sonic_rs::Value>(br#"{"b":1,"a":2,"b":3}"#).unwrap();
    let obj = v.as_object().unwrap();
    for (k, val) in obj {
        println!("dup entry: {k} = {}", sonic_rs::to_string(val).unwrap());
    }
    // Infinity / NaN literals
    for raw in ["Infinity", "NaN", "-Infinity"] {
        let r = sonic_rs::from_slice::<sonic_rs::Value>(raw.as_bytes());
        println!("{raw}: parse ok={}", r.is_ok());
    }
    // nested to_string of container with dup keys
    let v = sonic_rs::from_slice::<sonic_rs::Value>(br#"{"b":1,"a":2,"b":3}"#).unwrap();
    println!("container to_string: {:?}", sonic_rs::to_string(&v));
    // number in container to_string
    let v = sonic_rs::from_slice::<sonic_rs::Value>(br#"{"x":36,"y":-0,"z":1e400}"#);
    match v {
        Ok(v) => println!("mixed container: {:?}", sonic_rs::to_string(&v)),
        Err(e) => println!("mixed container parse err: {e}"),
    }
    // lone surrogate escape
    let r = sonic_rs::from_slice::<sonic_rs::Value>(br#""A""#.as_slice());
    println!("lone surrogate: ok={}", r.is_ok());
    // unicode string to_string escaping
    let v = sonic_rs::from_slice::<sonic_rs::Value>("\"héllo\"".as_bytes()).unwrap();
    println!("héllo: {:?}", sonic_rs::to_string(&v));
    let v = sonic_rs::from_slice::<sonic_rs::Value>(br#""aAb""#).unwrap();
    println!("escape: {:?}", sonic_rs::to_string(&v));
}
