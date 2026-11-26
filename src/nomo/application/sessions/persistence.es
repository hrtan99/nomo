module nomo.application.sessions.persistence;

import std.memory.{MemoryVersion, WriteCondition};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.domain.sessions.receipts.committed_version;

// Exactly one native commit. Unknown and refusal are domain outcomes; native
// failures escape. There is no retry or compensation after an uncertain write.
public flow commit_once<Row, S ~ CasRows<Row>>(rows: S, value: Row, condition: WriteCondition, previous: Option<MemoryVersion>) -> Result<MemoryVersion, string> {
    let target = rows.target();
    let attempt = rows.submit(value, condition);
    let version = match committed_version(target, attempt) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match rows.read() { Ok(Some(item)) => item, _ => { return Err(target.label + " readback missing"); } };
    if after.key != target.key || !rows.same(after.value, value) || after.version.opaque != version.opaque { return Err(target.label + " readback mismatch; no retry"); }
    match previous { Some(item) => { if item.opaque == version.opaque { return Err(target.label + " version did not change"); } } None() => {} }
    return Ok(version);
}
