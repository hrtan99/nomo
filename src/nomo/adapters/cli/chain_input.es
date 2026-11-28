module nomo.adapters.cli.chain_input;

import nomo.adapters.cli.edit_input.{Work, harness_work_args_parse};
import nomo.domain.editing.selector_error;
import nomo.domain.sessions.chain.{Selector, policy, turn_caps};
import nomo.session.work_chain.Caps;

public type WorkChainArgsInput = {
    work: Work,
    parent: string,
    cap: Caps
};

public flow work_chain_args_parse(args: Array<string>, continuing: bool) -> Result<WorkChainArgsInput, string> {
    if args.len() == 1 && (args[0] == "--help" || args[0] == "help") {
        let work = match harness_work_args_parse(args) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        return Ok(WorkChainArgsInput {
            work,
            parent = "",
            cap = turn_caps()
        });
    }
    if args.len() < 10 || args.len() > 14 || args.len() % 2 != 0 {
        return Err("expected bounded work selectors, optional --cap and continuation --parent");
    }
    var selected: Array<string> = [];
    var parent = "";
    var supplied_parent = false;
    var supplied_cap = false;
    var cap = turn_caps();
    var index: usize = 0;
    @limits([Iterations(7)]) while index < args.len() {
        let flag = args[index];
        let value = args[index + 1];
        if flag == "--parent" {
            if !continuing || supplied_parent {
                return Err("unexpected or duplicate --parent");
            }
            parent = value;
            supplied_parent = true;
        } else if flag == "--cap" {
            if supplied_cap {
                return Err("duplicate --cap");
            }
            supplied_cap = true;
            cap = match policy(value) {
                Ok(item) => item,
                Err(error) => {
                    return Err(error);
                }
            };
        } else {
            selected = selected.push(flag).push(value);
        }
        index = index + 2;
    }
    let work = match harness_work_args_parse(selected) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if continuing {
        if !supplied_parent {
            return Err("continuation requires explicit --parent");
        }
        let error = selector_error(parent, work.edit.workspace, work.edit.path);
        if error != "" {
            return Err(error);
        }
        if parent == work.edit.id {
            return Err("continuation requires a distinct child ID");
        }
    }
    return Ok(WorkChainArgsInput {
        work,
        parent,
        cap
    });
}

public enum Command {
    Sessions,
    Show
}

public type WorkChainSelectionArgsInput = {
    help: bool,
    selector: Selector,
    workspace: string,
    path: string
};

public flow work_chain_selection_args_parse(args: Array<string>, command: Command) -> Result<
    WorkChainSelectionArgsInput,
    string
> {
    let listing = match command {
        Command.Sessions => true,
        Command.Show => false
    };
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(
            WorkChainSelectionArgsInput {
                help = true,
                selector = Selector.All,
                workspace = "",
                path = ""
            }
        );
    }
    if args.len() < 4 || args.len() > 6 {
        return Err("expected bounded workspace/path and one --id or --latest selector");
    }
    var id = "";
    var workspace = "";
    var path = "";
    var latest = false;
    var supplied_id = false;
    var seen: Array<string> = [];
    var index: usize = 0;
    @limits([Iterations(4)]) while index < args.len() {
        let flag = args[index];
        if seen.iter().any(previous => previous == flag) {
            return Err("duplicate discovery selector");
        }
        seen = seen.push(flag);
        index = index + 1;
        if flag == "--latest" {
            if listing {
                return Err("sessions lists both fixed slots; no latest selector");
            }
            latest = true;
        } else {
            if index >= args.len() {
                return Err("discovery selector value missing");
            }
            let value = args[index];
            index = index + 1;
            match flag {
                "--workspace" => {
                    workspace = value;
                }
                "--path" => {
                    path = value;
                }
                "--id" => {
                    if listing {
                        return Err("sessions lists both fixed slots; no ID selector");
                    }
                    id = value;
                    supplied_id = true;
                }
                _ => {
                    return Err("unknown discovery selector");
                }
            }
        }
    }
    if !listing && latest == supplied_id {
        return Err("show requires exactly one --id or --latest");
    }
    let invalid = selector_error(if supplied_id {
        id
    } else {
        "discovery"
    }, workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    var selector: Selector = Selector.Exact(id);
    if latest {
        selector = Selector.Latest;
    }
    if listing {
        selector = Selector.All;
    }
    return Ok(WorkChainSelectionArgsInput {
        help = false,
        selector,
        workspace,
        path
    });
}
