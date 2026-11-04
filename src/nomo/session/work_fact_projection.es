module nomo.session.work_fact_projection;

import std.text.split;
import nomo.session.work_fact_events.{summary_source, selection};
import nomo.session.history_work_guard.Record;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.application.check_contract.CheckFacts;
import nomo.session.continuous_work.Entry;
import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.decode;
import nomo.application.history_contract.{WorkFacts, CheckOutput};

// Pure projections of captured historical records; no storage, file or model calls.
public flow extra_fact(item: Entry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase == "abandoned" && (item.check.phase == "none" || item.check.phase == "planned") { return Ok(WorkFacts { id = item.core.id, summary = "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", summary_source = "system", selection = None(), check = "unknown", exit_code = "", output = None() }); }
    if item.result.phase != "complete" || (item.check.phase != "none" && item.check.phase != "complete" && item.check.phase != "abandoned") { return Err("continuous work unresolved"); }
    var output: Option<CheckOutput> = None();
    if item.check.phase == "complete" {
        output = Some(match check_values(item.check.stdout, item.check.stderr, item.check.stdout_truncated, item.check.stderr_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } });
    }
    let chosen = match selection(item.result.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = item.core.id, summary = item.result.summary, summary_source = if (item.result.source == "model-v2" || item.result.source == "model-v3" || item.result.source == "model-v4") { "model" } else { if (item.result.source == "system-v2" || item.result.source == "system-v3" || item.result.source == "system-v4") { "system" } else { item.result.source } }, selection = chosen,
        check = if item.check.phase == "none" { "not requested" } else { if item.check.phase == "abandoned" { "abandoned; outcome unknown" } else { item.check.outcome } }, exit_code = item.check.exit_code, output = output });
}
// Keep older diagnostics at the original per-stream context bound; the stored
// excerpts remain intact and the two latest checks retain their wider context.
flow short_text(value: string) -> string {
    var result = ""; var size: usize = 0;
    for item in split(value, "") limit Iterations(262146) { if item != "" { if size < 128 { result = result + item; } size = size + 1; } }
    return result;
}
public flow compact(value: WorkFacts) -> WorkFacts {
    let output = match value.output { None() => None(), Some(item) => {
        let out = short_text(item.stdout); let err = short_text(item.stderr);
        Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = item.stdout_truncated || out != item.stdout, stderr_truncated = item.stderr_truncated || err != item.stderr })
    } };
    return WorkFacts { id = value.id, summary = value.summary, summary_source = value.summary_source, selection = value.selection, check = value.check, exit_code = value.exit_code, output = output };
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
    return Ok(WorkFacts { id = work.id, summary = work.summary, summary_source = origin, selection = chosen, check = outcome, exit_code = exit, output = output });
}
