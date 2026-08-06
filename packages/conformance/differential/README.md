# Differential Fuzz — packages/conformance/differential

This directory will host the differential fuzz generator that asserts
`safeParseJson(bytes)` and `safeParse(JSON.parse(bytes))` produce deep-equal
values and deep-equal issue arrays across random schemas and random inputs.

The generator is a later task. Until it lands, this directory is empty and
the `differential` vitest project is a no-op (passWithNoTests keeps the
config valid).

Planned coverage:

- Random schemas from the Plan IR grammar
- Valid, near-miss, and adversarial inputs
- `__proto__` keys, lone surrogates, `1e400`, deeply nested arrays
- Duplicate JSON keys, BOM, NaN literals
- Minimum 100k cases in CI
