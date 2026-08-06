//! napi bindings over `zodrs`. Exposes exactly three functions:
//! `compile`, `dispose`, `validate_json`.
//! Plans live in an `RwLock<Slab<Plan>>` keyed by `u32`.
