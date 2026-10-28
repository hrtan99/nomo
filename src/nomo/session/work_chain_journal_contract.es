module nomo.session.work_chain_journal_contract;

import nomo.session.edit_operation.{Binding, selector_error, binding_error};

public type CapturedJournal = { format: i32, chain: string, turn: i32, phase: string, binding: Binding };

public flow invalid(row: CapturedJournal) -> string {
    if row.format != 2 || (row.turn != 1 && row.turn != 2) || (row.phase != "intent" && row.phase != "completed") {
        return "invalid v2 edit journal format, turn or phase";
    }
    let binding = binding_error(row.binding); if binding != "" { return binding; }
    let chain = selector_error(row.chain, row.binding.workspace, row.binding.path); if chain != "" { return chain; }
    if (row.turn == 1 && row.chain != row.binding.id) || (row.turn == 2 && row.chain == row.binding.id) {
        return "v2 edit journal chain identity mismatch";
    }
    return "";
}
