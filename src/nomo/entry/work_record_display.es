module nomo.entry.work_record_display;

import std.collections.len as count;
import std.text.{char_count as len, from_i32, from_usize};
import nomo.session.work_record.{Record, validate};
import nomo.tools.edit_encoding.object;

public flow render(row: Record) -> Result<Array<string>, string> {
    let value = match validate(row) { Ok(item) => item, Err(error) => { return Err(error); } };
    let binding = value.binding; let read = value.evidence; let state = value.ledger;
    var allowed2 = ""; if count(read.allowed) == 2 { allowed2 = read.allowed[1]; }
    var selected2 = ""; if count(read.files) == 2 { selected2 = read.files[1]; }
    let remaining = if row.phase == "summary-confirmed" { ["0", "0", "0", "0"] } else { ["1", "1", "2048", "65536"] };
    let labels = ["WORK ", "READ ", "EDIT ", "READ_LEDGER ", "EDIT_LEDGER ", "MAXIMA ", "RESERVATION "];
    let keys = [["format", "phase", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
        ["request", "task", "operation", "allowed1", "allowed2", "selected1", "selected2", "literal", "outcome", "result", "summary"],
        ["task", "target", "replacement", "before", "after", "summary"],
        ["steps", "calls", "generation", "tools", "scan"], ["steps", "calls", "generation", "native_tokens", "boundaries"],
        ["steps", "calls", "generation", "native_tokens", "read_tools", "scan", "edit_reads", "edit_read_bytes", "atomic_attempts", "edit_bytes"],
        ["steps", "calls", "generation", "native_tokens"]];
    let values = [["nomo-work-record-v1", row.phase, binding.id, binding.workspace, binding.region, binding.path,
        binding.request_digest, binding.before_digest, binding.after_digest, from_usize(binding.before_bytes), from_usize(binding.after_bytes)],
        [read.request, read.task, read.operation, read.allowed[0], allowed2, read.files[0], selected2, read.literal, read.outcome, read.result, read.summary],
        [value.task, value.target, value.replacement, value.before, value.after, value.summary],
        [from_i32(state.read.steps), from_i32(state.read.calls), from_i32(state.read.tokens), from_i32(state.read.tools), from_i32(state.read.scan)],
        [from_i32(state.edit.steps), from_i32(state.edit.calls), from_i32(state.edit.tokens), from_i32(state.edit.native_tokens), from_i32(state.edit.boundaries)],
        ["13", "7", "47104", "196608", "1", "4096", "3", "6144", "1", "2048"], remaining];
    var output: Array<string> = []; var index: usize = 0; var size: usize = 0;
    while index < 7 limit Iterations(7) {
        let encoded = match object(keys[index], values[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        size = size + len(labels[index]) + len(encoded) + 1;
        if size > 131072 { return Err("work display exceeds 131072 ASCII bytes"); }
        output = output.push(labels[index] + encoded); index = index + 1;
    }
    return Ok(output);
}
