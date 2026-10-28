module nomo.entry.work_chain_sessions;

import std.io.println;
import std.collections.len as count;
import std.text.to_string_i32;
import nomo.cli.work_chain_selection_args.{Command, parse};
import nomo.session.work_chain_selection.{Selector, select, eligible, journal_phase};
import nomo.session.work_chain_store.discover;
import nomo.entry.work_chain_entry.show_captured;
import nomo.entry.work_chain_help.{help, help_hint};
import nomo.tools.edit_encoding.object;

flow refused(error: string) -> i32 { println("REFUSED " + error); help_hint(); return 1; }
public flow run_sessions(args: Array<string>) -> i32 {
    let input = match parse(args, Command.Sessions) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.help { return help([]); }
    let view = match discover(input.workspace, input.path, Selector.All) { Ok(value) => value, Err(error) => { return refused(error); } };
    let rows = match select(view, input.workspace, input.path, Selector.All) { Ok(value) => value, Err(error) => { return refused(error); } };
    if count(rows) == 0 { println("SESSIONS empty; missing records never establish that no edit occurred."); }
    for row in rows limit Iterations(2) {
        let encoded = match object(["id", "turn", "phase", "journal", "continuation_eligible", "workspace", "path"],
            [row.id, to_string_i32(row.turn), row.phase, journal_phase(view, row.turn),
                if row.turn == 1 && eligible(view, input.workspace, input.path) { "true" } else { "false" }, row.workspace, row.path]) {
            Ok(value) => value, Err(error) => { return refused(error); } };
        println("SESSION " + encoded);
    }
    println("Captured fixed slots only. Continuation revalidates the graph, journals and admission; no replay, refund or current File claim.");
    return 0;
}
public flow run_show(args: Array<string>) -> i32 {
    let input = match parse(args, Command.Show) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.help { return help([]); }
    let view = match discover(input.workspace, input.path, input.selector) { Ok(value) => value, Err(error) => { return refused(error); } };
    let selected = match select(view, input.workspace, input.path, input.selector) { Ok(value) => value, Err(error) => { return refused(error); } };
    if count(selected) == 0 { println("CHAIN missing; missing data never establishes no edit occurred."); return 0; }
    let row = selected[0];
    let observed = if row.turn == 1 { view.root_journal } else { view.child_journal };
    let journal = match observed { Some(value) => Some(value.value), None() => None() };
    return show_captured(row, journal);
}
