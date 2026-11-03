module nomo.session.work_fact_events;

import nomo.core.conversation.Event;
import nomo.entry.harness_work_entry.{Pending, Summary};
import nomo.entry.edit_coordinator.Confirmed;
import nomo.tools.edit_binding.bind;
import nomo.harness.harness_work_contract.ledger_error;
import nomo.harness.harness_edit_contract.history_summary_error;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.session.event_text_codec.decode;
import nomo.session.redaction.Policy;

// Selected, validated facts from the actual work controller. This is not a
// complete raw model/effect trace, and an approval event is not a future grant.
public flow capture(pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> {
    let selected = pending.selected;
    let expected = match bind(selected.id, selected.workspace, selected.path, pending.prepared) {
        Ok(item) => item, Err(error) => { return Err(error); }
    };
    if expected != confirmed.binding || confirmed.after != pending.prepared.proposal.after {
        return Err("confirmed edit differs from prepared work");
    }
    let problem = ledger_error(summary.state); if problem != "" { return Err(problem); }
    let invalid = history_summary_error(summary.answer, "summary"); if invalid != "" { return Err(invalid); }
    let read = pending.evidence;
    return Ok([
        Event { role = "user", kind = "request", name = "", text = pending.request },
        Event { role = "tool", kind = "result", name = read.operation, text = read.outcome },
        Event { role = "assistant", kind = "result", name = "read-child", text = read.result },
        Event { role = "assistant", kind = "result", name = "read-summary", text = read.summary },
        Event { role = "assistant", kind = "delegate", name = "edit-child", text = pending.task },
        Event { role = "user", kind = "approval", name = "edit", text = "confirmed for this invocation only" },
        Event { role = "tool", kind = "applied", name = "edit", text = selected.id },
        Event { role = if summary.model_generated { "assistant" } else { "system" }, kind = if summary.model_generated { "answer" } else { "notice" }, name = "", text = summary.answer }
    ]);
}

// Older or incomplete records may lack attributable events; never guess their origin.
public flow summary_source(frame: EventFrame, summary: string, policy: Policy) -> Result<string, string> {
    var origin = "unknown"; var matches: usize = 0;
    for event in frame.events limit Iterations(48) {
        if (event.role == "assistant" && event.kind == "answer") || (event.role == "system" && event.kind == "notice") {
            let value = match decode(event.text, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
            if value == summary { matches = matches + 1; origin = if event.role == "system" { "system" } else { "model" }; }
        }
    }
    return Ok(if matches == 1 { origin } else { "unknown" });
}
