module nomo.entry.work_chain_display;

import std.text.{len, to_string_i32, to_string_usize};
import nomo.session.work_chain.{Record, values, validate};
import nomo.session.work_chain_journal.Record as Journal;
import nomo.tools.edit_encoding.object;
import nomo.entry.work_record_display.render as work_lines;

public flow render(row: Record, journal: Option<Journal>) -> Result<Array<string>, string> {
    let error = validate(row); if error != "" { return Err(error); }
    let metadata = match object(["format", "phase", "chain", "id", "turn", "workspace", "region", "path", "parent_id", "parent_version", "parent_digest", "request"],
        ["2", row.phase, row.chain, row.id, to_string_i32(row.turn), row.workspace, row.region, row.path, row.parent_id, row.parent_version, row.parent_digest, row.request]) {
        Ok(value) => value, Err(error) => { return Err(error); } };
    var lines = ["CHAIN " + metadata]; let labels = ["ALLOWANCE ", "AVAILABLE ", "REMAINING ", "RESERVATION "];
    let caps = [row.maximum, row.available, row.remaining, row.reserved]; var index: usize = 0;
    let keys = ["steps", "calls", "generation", "native_tokens", "read_tools", "scan", "edit_reads", "edit_read_bytes", "atomic", "atomic_bytes"];
    while index < 4 limit Iterations(4) {
        var text: Array<string> = []; for number in values(caps[index]) limit Iterations(10) { text = text.push(to_string_i32(number)); }
        let encoded = match object(keys, text) { Ok(value) => value, Err(error) => { return Err(error); } };
        lines = lines.push(labels[index] + encoded); index = index + 1;
    }
    match journal {
        Some(value) => {
            let b = value.binding;
            let encoded = match object(["format", "phase", "chain", "turn", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
                ["2", value.phase, value.chain, to_string_i32(value.turn), b.id, b.workspace, b.region, b.path, b.request_digest, b.before_digest, b.after_digest, to_string_usize(b.before_bytes), to_string_usize(b.after_bytes)]) {
                Ok(item) => item, Err(error) => { return Err(error); } };
            lines = lines.push("JOURNAL " + encoded);
        }
        None() => { lines = lines.push("JOURNAL missing; missing journal is not proof that no edit occurred."); }
    }
    match row.work { Some(value) => { let shown = match work_lines(value) { Ok(item) => item, Err(error) => { return Err(error); } }; for line in shown limit Iterations(7) { lines = lines.push(line); } } None() => {} }
    var size: usize = 0; for line in lines limit Iterations(16) { size = size + len(line) + 1; }
    if size > 262144 { return Err("chain display exceeds 262144 ASCII bytes"); }
    return Ok(lines);
}
