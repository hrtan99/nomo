module nomo.cli.work_chain_args;

import std.collections.len as count;
import nomo.cli.harness_work_args.{Work, parse as work_args};
import nomo.session.edit_operation.selector_error;
import nomo.session.work_chain.{Caps, turn_caps, policy};

public type Input = { work: Work, parent: string, cap: Caps };
public flow parse(args: Array<string>, continuing: bool) -> Result<Input, string> {
    if count(args) == 1 && (args[0] == "--help" || args[0] == "help") {
        let work = match work_args(args) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok(Input { work = work, parent = "", cap = turn_caps() });
    }
    if count(args) < 10 || count(args) > 14 || count(args) % 2 != 0 { return Err("expected bounded work selectors, optional --cap and continuation --parent"); }
    var selected: Array<string> = []; var parent = ""; var supplied_parent = false; var supplied_cap = false;
    var cap = turn_caps(); var index: usize = 0;
    while index < count(args) limit Iterations(7) {
        let flag = args[index]; let value = args[index + 1];
        if flag == "--parent" {
            if !continuing || supplied_parent { return Err("unexpected or duplicate --parent"); }
            parent = value; supplied_parent = true;
        } else if flag == "--cap" {
            if supplied_cap { return Err("duplicate --cap"); } supplied_cap = true;
            cap = match policy(value) { Ok(item) => item, Err(error) => { return Err(error); } };
        } else { selected = selected.push(flag).push(value); }
        index = index + 2;
    }
    let work = match work_args(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    if continuing {
        if !supplied_parent { return Err("continuation requires explicit --parent"); }
        let error = selector_error(parent, work.edit.workspace, work.edit.path); if error != "" { return Err(error); }
        if parent == work.edit.id { return Err("continuation requires a distinct child ID"); }
    }
    return Ok(Input { work = work, parent = parent, cap = cap });
}
