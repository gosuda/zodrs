//! napi bindings over `zodrs`. Exposes exactly four functions:
//! `compile`, `dispose`, `validate_json`, `to_json_schema`.
//! Plans live in a `RwLock<Slab<Plan>>` keyed by `u32`.
