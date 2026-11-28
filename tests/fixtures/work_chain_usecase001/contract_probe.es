module app.usecase_probe;

import std.io.println;
import nomo.domain.editing.Selector;
import nomo.session.work_chain.Caps;
import nomo.domain.sessions.chain.turn_caps;
import nomo.domain.sessions.chain.values;
import nomo.domain.sessions.chain.WorkRequest;
import nomo.domain.sessions.chain.ContinueRequest;
import nomo.domain.sessions.chain.TurnRequest;
import nomo.domain.sessions.chain.WorkOutcome;
import nomo.domain.sessions.chain.WorkStop;
import nomo.application.sessions.ports.TerminalWork;
import nomo.application.sessions.ports.TerminalRead;
import nomo.application.sessions.chain.request_error;
import nomo.application.sessions.chain.dispatch;
import nomo.application.sessions.chain.read_selected;
import nomo.application.sessions.chain.read_latest;
import nomo.harness.harness_work_contract.Ledger;
import nomo.domain.harness.work.fresh;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.domain.harness.edit.fresh as edit_fresh;

type Check = { label: string, passed: bool };
flow checks() -> Array<Check> { return __CHECKS__; }
flow invalid(request: TurnRequest, expected: string) -> bool {
    let result = handle dispatch(request) with { TerminalWork.execute(value) => abort("invalid typed work requested an operation"); };
    return request_error(request) == expected && result == WorkOutcome.Stopped(WorkStop { state = fresh(), error = expected });
}
flow unchanged(request: TurnRequest) -> bool {
    let state = Ledger { read = ReadLedger { steps = 2, calls = 1, tokens = 2048, tools = 0, scan = 0 }, edit = edit_fresh() };
    let original = WorkOutcome.Stopped(WorkStop { state = state, error = "v2 work-chain commit unknown; admission retained, no retry" });
    let result = handle dispatch(request) with {
        TerminalWork.execute(value) => { if value != request { abort("dispatch changed typed request"); } resume original; }
    };
    return result == original;
}
flow invalid_read(selected: Selector, expected: string) -> bool {
    let result = handle read_selected(selected) with { TerminalRead.show(value) => abort("invalid read requested an operation"); };
    return result == Err(expected);
}
flow invalid_latest(workspace: string, path: string, expected: string) -> bool {
    let result = handle read_latest(workspace, path) with { TerminalRead.latest(workspace, path) => abort("invalid latest requested an operation"); };
    return result == Err(expected);
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(32) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) {
        if !item.passed { println("FAIL " + item.label); abort("typed usecase contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
