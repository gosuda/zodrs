//! Order-preserving deserialization of free-form JSON values in the plan IR.
//!
//! Two constraints rule out a plain `sonic_rs::Value` field:
//!
//! 1. `Value` deserializes through a private newtype token, so it only works
//!    with sonic's own deserializer. Serde buffers every internally-tagged
//!    enum (`PlanNode`, `Check`) into `Content` first, and replaying that
//!    buffer into `Value` fails.
//! 2. A `Value` built by mutation is hash-backed, so rebuilding one from
//!    visitor callbacks would scramble object key order. Canonical output
//!    writes plan defaults verbatim, so that order is observable.
//!
//! The visitor below writes the value back out as JSON text in visit order,
//! then parses that text once. Parsed values are document-backed, so key
//! order survives. This runs at plan-compile time only.

use std::fmt::{self, Formatter};

use serde::Deserialize;
use serde::de::{DeserializeSeed, Deserializer, Error, MapAccess, SeqAccess, Visitor};
use sonic_rs::Value as Json;

use crate::plan::NodeId;

/// A plan JSON value, parsed through its text form.
struct JsonWire(Json);

impl<'de> Deserialize<'de> for JsonWire {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut text = String::new();
        deserializer.deserialize_any(JsonText(&mut text))?;
        sonic_rs::from_str(&text)
            .map(JsonWire)
            .map_err(D::Error::custom)
    }
}

/// Deserializes one plan JSON value.
///
/// # Errors
///
/// Fails when the value is not representable as JSON.
pub fn json<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
    JsonWire::deserialize(deserializer).map(|w| w.0)
}

/// Deserializes an optional plan JSON value.
///
/// # Errors
///
/// Fails when the value is not representable as JSON.
pub fn json_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Json>, D::Error> {
    Option::<JsonWire>::deserialize(deserializer).map(|w| w.map(|w| w.0))
}

/// Deserializes a list of plan JSON values.
///
/// # Errors
///
/// Fails when any value is not representable as JSON.
pub fn json_vec<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Json>, D::Error> {
    Vec::<JsonWire>::deserialize(deserializer).map(|v| v.into_iter().map(|w| w.0).collect())
}

/// Deserializes discriminant-to-node pairs.
///
/// # Errors
///
/// Fails when any discriminant is not representable as JSON.
pub fn json_pairs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<(Json, NodeId)>, D::Error> {
    Vec::<(JsonWire, NodeId)>::deserialize(deserializer)
        .map(|v| v.into_iter().map(|(w, id)| (w.0, id)).collect())
}

/// Writes whatever it visits into `0` as JSON text, in visit order.
struct JsonText<'a>(&'a mut String);

impl<'de> DeserializeSeed<'de> for JsonText<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl JsonText<'_> {
    fn scalar(&mut self, text: &str) {
        self.0.push_str(text);
    }
}

impl<'de> Visitor<'de> for JsonText<'_> {
    type Value = ();

    fn expecting(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E: Error>(mut self, v: bool) -> Result<(), E> {
        self.scalar(if v { "true" } else { "false" });
        Ok(())
    }

    fn visit_i64<E: Error>(mut self, v: i64) -> Result<(), E> {
        self.scalar(&v.to_string());
        Ok(())
    }

    fn visit_u64<E: Error>(mut self, v: u64) -> Result<(), E> {
        self.scalar(&v.to_string());
        Ok(())
    }

    fn visit_i128<E: Error>(mut self, v: i128) -> Result<(), E> {
        self.scalar(&v.to_string());
        Ok(())
    }

    fn visit_u128<E: Error>(mut self, v: u128) -> Result<(), E> {
        self.scalar(&v.to_string());
        Ok(())
    }

    /// JSON has no non-finite numbers, so those degrade to `null` exactly as
    /// `JSON.stringify` does.
    fn visit_f64<E: Error>(mut self, v: f64) -> Result<(), E> {
        let text = Json::new_f64(v)
            .and_then(|n| sonic_rs::to_string(&n).ok())
            .unwrap_or_else(|| "null".into());
        self.scalar(&text);
        Ok(())
    }

    fn visit_str<E: Error>(mut self, v: &str) -> Result<(), E> {
        let text = sonic_rs::to_string(v).map_err(E::custom)?;
        self.scalar(&text);
        Ok(())
    }

    fn visit_unit<E: Error>(mut self) -> Result<(), E> {
        self.scalar("null");
        Ok(())
    }

    fn visit_none<E: Error>(mut self) -> Result<(), E> {
        self.scalar("null");
        Ok(())
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_newtype_struct<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let out = self.0;
        out.push('[');
        let mut first = true;
        loop {
            // The separator is speculative: `next_element_seed` is the only
            // way to learn the sequence ended, and it writes nothing then.
            let mark = out.len();
            if !first {
                out.push(',');
            }
            if seq.next_element_seed(JsonText(out))?.is_none() {
                out.truncate(mark);
                break;
            }
            first = false;
        }
        out.push(']');
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let out = self.0;
        out.push('{');
        let mut first = true;
        while let Some(key) = map.next_key::<String>()? {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&sonic_rs::to_string(&key).map_err(A::Error::custom)?);
            out.push(':');
            map.next_value_seed(JsonText(out))?;
        }
        out.push('}');
        Ok(())
    }
}
