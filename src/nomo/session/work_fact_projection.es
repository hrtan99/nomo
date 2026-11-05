module nomo.session.work_fact_projection;

import std.text.{char_count, get_char_slice};
import nomo.session.work_fact_events.{summary_source, selection, evidence};
import nomo.session.history_work_guard.Record;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.application.check_contract.CheckFacts;
import nomo.session.continuous_work.Entry;
import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.decode;
import nomo.application.history_contract.{WorkFacts, CheckOutput};
import nomo.harness.harness_work_contract.Ledger;

public type WorkUsage = { calls: i32, generation: i32 };

public flow settled_usage(value: Ledger) -> WorkUsage {
    return WorkUsage { calls = value.read.calls + value.edit.calls, generation = value.read.tokens + value.edit.tokens };
}

public flow stored_fact(id: string, summary: string, source: string, check: string, exit_code: string, output: Option<CheckOutput>) -> WorkFacts {
    return WorkFacts { id = id, summary = summary, summary_source = source, selection = None(), evidence = None(), check = check, exit_code = exit_code, output = output };
}

public flow abandoned_fact(id: string) -> WorkFacts {
    return stored_fact(id, "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", "system", "unknown", "", None());
}

// Pure projections of captured historical records; no storage, file or model calls.
public flow extra_fact(item: Entry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase == "abandoned" && (item.check.phase == "none" || item.check.phase == "planned") { return Ok(abandoned_fact(item.core.id)); }
    if item.result.phase != "complete" || (item.check.phase != "none" && item.check.phase != "complete" && item.check.phase != "abandoned") { return Err("continuous work unresolved"); }
    var output: Option<CheckOutput> = None();
    if item.check.phase == "complete" {
        output = Some(match check_values(item.check.stdout, item.check.stderr, item.check.stdout_truncated, item.check.stderr_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } });
    }
    let chosen = match selection(item.result.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let observed = match evidence(item.result.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = item.core.id, summary = item.result.summary, summary_source = if (item.result.source == "model-v2" || item.result.source == "model-v3" || item.result.source == "model-v4" || item.result.source == "model-v5" || item.result.source == "model-high-input") { "model" } else { if (item.result.source == "system-v2" || item.result.source == "system-v3" || item.result.source == "system-v4" || item.result.source == "system-v5" || item.result.source == "system-high-input") { "system" } else { item.result.source } }, selection = chosen, evidence = observed,
        check = if item.check.phase == "none" { "not requested" } else { if item.check.phase == "abandoned" { "abandoned; outcome unknown" } else { item.check.outcome } }, exit_code = item.check.exit_code, output = output });
}
// Keep older diagnostics at the original per-stream context bound; the stored
// excerpts remain intact and the two latest checks retain their wider context.
flow short_text(value: string) -> string {
    if char_count(value) <= 128 { return value; }
    return match get_char_slice(value, Range.closed(0, 127)) {
        Some(text) => text,
        None() => ""
    };
}
public flow compact(value: WorkFacts) -> WorkFacts {
    let output = match value.output { None() => None(), Some(item) => {
        let out = short_text(item.stdout); let err = short_text(item.stderr);
        Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = item.stdout_truncated || out != item.stdout, stderr_truncated = item.stderr_truncated || err != item.stderr })
    } };
    return WorkFacts { id = value.id, summary = value.summary, summary_source = value.summary_source, selection = value.selection, evidence = None(), check = value.check, exit_code = value.exit_code, output = output };
}
// Only completed recorded actions become untrusted model context. An uncertain
// edit or check is not retried and cannot be represented as a successful fact.
public flow check_values(stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy) -> Result<CheckOutput, string> {
    let out = match decode(stdout, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match decode(stderr, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(CheckOutput { stdout = out, stderr = err, stdout_truncated = out_truncated, stderr_truncated = err_truncated });
}
public flow completed_fact(work: Record, events: EventFrame, check: Option<CheckFacts>, policy: Policy, label: string) -> Result<WorkFacts, string> {
    var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
    match check { Some(value) => {
        if value.phase == "abandoned" { outcome = "abandoned; outcome unknown"; } else {
        if value.phase != "complete" { return Err(label + " check unresolved"); }
        outcome = value.outcome; exit = value.exit_code;
        output = value.output; }
    } None() => {} }
    let origin = match summary_source(events, work.summary, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let chosen = match selection(events.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let observed = match evidence(events.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = work.id, summary = work.summary, summary_source = origin, selection = chosen, evidence = observed, check = outcome, exit_code = exit, output = output });
}
