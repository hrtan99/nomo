# Explicit string-state upgrade fixtures

These one-time migration declarations and programs stay outside the product import
graph. The runtime reads and writes Memory values with Etas's official codecs;
Python transports encoded bytes and names only. Counters never pass through JSON
floating-point numbers.

- `legacy_declarations.json` freezes the 43 passive declarations changed from the
  post-consolidation baseline `60dc3a9`. They are appended only to a temporary
  migration package, under their original defining modules and package identity.
- `schema_60dc3a9.json` records the old reachable field graph.
- `baseline_*` read the post-consolidation `native-string-state` layout;
  `historical_*` read the pre-consolidation `native-02413` layout. The latter's
  original declarations remain in `../state_relocation/old/src`.
- `state_upgrade.es` decodes coupled check, summary, edit and reference states.
  Other converters preserve every unrelated field while changing owned tags to
  enums. Unsupported closed-state spellings fail conversion; open native/imported
  role labels remain unchanged. Unknown results remain unknown.
- `*_sources.es` preserve all 43 store paths and stable Region IDs, including the
  optional v4 prototype stores. Exporters encode the destination record with the
  official codec; `../state_relocation/import.es` inserts it into fresh stores.
- `*_seed.es` produce synthetic old records with meaningful state tags, unfinished
  work, historical provenance, an integer above 2^53 and raw Unicode/binary data.
  Five protocol goldens come from the old types, independently of new encoders.
- `consume.es` reads every migrated store in a new process, checks 33 relevant
  facts, and emits the same five protocol samples for byte comparison.

Run `python3 tests/string_state_probe.py` for the immediate baseline, or
`python3 tests/state_relocation_probe.py` for the pre-consolidation layout. Each
runs one old writer, the real explicit migration command, then one new reader.
Sources, receipts and filesystem metadata must be retained. These probes use no
real model and do not replay edits, commands, approvals or recovery actions.
