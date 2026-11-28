module nomo.adapters.cli.terminal;

import nomo.adapters.cli.chains.{execute_application_detailed, inspect_application, present_detailed_outcome, present_show, project_outcome};
import nomo.adapters.cli.session_input.{Config, LineCommand, bind_parent, line, parse_once, show_selector, terminal_args_parse, work_request};
import nomo.adapters.storage.chains.latest_parent;
import nomo.application.conversation.interactive.{State, after_turn, fresh, turn, work_error};
import nomo.application.resources.{EditableRoot, ReadOnlyRoot};
import nomo.application.sessions.chain.{dispatch, latest_error, read_latest, read_selected};
import nomo.application.sessions.ports.{TerminalRead, TerminalWork};
import nomo.domain.limits.request_bytes;
import nomo.domain.sessions.chain.{WorkOutcome, turn_caps, values};
import nomo.domain.wire.{json, object};
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println, read_line};
import std.text.{char_count, from_i32, join};

// Configuration display only; this neither reads a durable balance nor grants work.
public flow state_line(
    state: State,
    root_id: string,
    child_id: string,
    workspace: string,
    path: string,
    cap: string,
    once: bool
) -> Result<string, string> {
    let selected_turn = turn(state);
    if selected_turn != 1 && selected_turn != 2 {
        return Err("invalid terminal display turn");
    }
    let phase = match state {
        State.First => "first",
        State.Second => "second",
        State.Stopped(_) => "stopped"
    };
    let remaining = match state {
        State.First => if once {
            1
        } else {
            2
        },
        State.Second => 1,
        State.Stopped(_) => 0
    };
    let current = if selected_turn == 1 {
        root_id
    } else {
        child_id
    };
    let value = match object(
        [
            "phase",
            "root_id",
            "current_id",
            "turn",
            "configured_turns_in_process",
            "workspace",
            "path",
            "configured_cap",
            "once",
            "scope"
        ],
        [
            phase,
            root_id,
            current,
            from_i32(selected_turn),
            from_i32(remaining),
            workspace,
            path,
            if cap == "" {
                "work-chain defaults"
            } else {
                cap
            },
            if once {
                "true"
            } else {
                "false"
            },
            "configuration only; not a durable balance, File observation or permission"
        ]
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok("SESSION " + value);
}

// Escaping is separate from request validation and supplies no execution authority.
public flow request_line(request: string) -> Result<string, string> {
    if char_count(request) > request_bytes() {
        return Err("terminal request display exceeds 65536 characters");
    }
    return match json([request]) {
        Ok(value) => Ok("USER " + value),
        Err(error) => Err(error)
    };
}

flow refused(error: string) -> i32 {
    let encoded = match json([error]) {
        Ok(value) => value,
        Err(_) => "[\"terminal diagnostic encoding refused\"]"
    };
    println("ERROR " + encoded);
    return 1;
}

flow selected_config(config: Config) -> Result<Config, string> {
    if !config.latest {
        return Ok(config);
    }
    let parent = match read_latest(config.workspace, config.path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return bind_parent(config, parent);
}

flow policy(config: Config) -> string {
    if config.cap_raw != "" {
        return config.cap_raw;
    }
    var parts: Array<string> = [];
    @limits([Iterations(10)]) for value in values(turn_caps()) {
        parts = parts.push(from_i32(value));
    }
    return join(parts, ",");
}

flow display(config: Config, state: State) -> Result<bool, string> {
    let rendered = match state_line(
        state,
        config.root_id,
        config.child_id,
        config.workspace,
        config.path,
        policy(config),
        config.once_supplied
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    println(rendered);
    return Ok(true);
}

flow request(config: Config, state: State, text: string) -> Result<State, string> {
    let invalid = work_error(state);
    if invalid != "" {
        return Err(invalid);
    }
    let operation = match work_request(config, turn(state), text) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let rendered = match request_line(text) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    println(rendered);
    let outcome = dispatch(operation);
    let completed = match outcome {
        WorkOutcome.Completed => true,
        WorkOutcome.Stopped(_) => false
    };
    let next = match after_turn(state, completed, config.once_supplied) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match display(config, next) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    if !completed {
        return Err("work stopped; inspect captured work and journal state before any further action");
    }
    return Ok(next);
}

flow show(config: Config, state: State) -> i32 {
    // Explicit selectors only. Missing/captured records never advance control state.
    let root = match show_selector(config, 1) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    if present_show(read_selected(root)) != 0 {
        return 1;
    }
    if turn(state) == 2 {
        let child = match show_selector(config, 2) {
            Ok(value) => value,
            Err(error) => {
                return refused(error);
            }
        };
        if present_show(read_selected(child)) != 0 {
            return 1;
        }
    }
    return 0;
}

public flow run_with_operations(args: Array<string>) -> i32 ![
    Console,
    TerminalWork.execute,
    TerminalRead.show,
    TerminalRead.latest,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let parsed = match terminal_args_parse(args) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    if parsed.help {
        return help([]);
    }
    let config = match selected_config(parsed) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    var state = fresh(config.parent != "");
    match display(config, state) {
        Ok(_) => (),
        Err(error) => {
            return refused(error);
        }
    }
    if config.once_supplied {
        match request(config, state, config.once) {
            Ok(_) => {
                return 0;
            }
            Err(error) => {
                return refused(error);
            }
        }
    }
    var lines: i32 = 0;
    @limits([Iterations(32)]) while lines < 32 {
        println("REQUEST /help /show /exit");
        let raw = read_line();
        lines = lines + 1;
        // Only malformed input recovers; admitted work errors still stop.
        match line(raw) {
            Err(error) => {
                let refused_status = refused(error);
            }
            Ok(command) => match command {
                LineCommand.Eof => {
                    println("STOP EOF; captured state is preserved");
                    return 0;
                }
                LineCommand.Exit => {
                    println("STOP exit; captured state is preserved");
                    return 0;
                }
                LineCommand.Help => {
                    if help([]) != 0 {
                        return 1;
                    }
                },
                LineCommand.Show => {
                    if show(config, state) != 0 {
                        return 1;
                    }
                },
                LineCommand.Request(text) => {
                    state = match request(config, state, text) {
                        Ok(value) => value,
                        Err(error) => {
                            return refused(error);
                        }
                    };
                    if work_error(state) != "" {
                        println("STOP selected work complete; no further request in this process");
                        return 0;
                    }
                }
            },
        }
    }
    return refused("terminal input limit reached; inspect captured state; no further request in this process");
}

// No outer request read: missing --once is refused before any work admission.
public flow run_once_with_operations(args: Array<string>) -> i32 ![
    Console,
    TerminalWork.execute,
    TerminalRead.show,
    TerminalRead.latest,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let parsed = match parse_once(args) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    if parsed.help {
        return help([]);
    }
    let config = match selected_config(parsed) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    let state = fresh(config.parent != "");
    match display(config, state) {
        Ok(_) => (),
        Err(error) => {
            return refused(error);
        }
    }
    return match request(config, state, config.once) {
        Ok(_) => 0,
        Err(error) => refused(error)
    };
}

flow latest_application(workspace: string, path: string) -> Result<string, string> {
    let invalid = latest_error(workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    return latest_parent(workspace, path);
}

flow production(args: Array<string>, once: bool) -> i32 {
    return handle if once {
        run_once_with_operations(args)
    } else {
        run_with_operations(args)
    } with {
        TerminalWork.execute(request) => {
            let detailed = execute_application_detailed(request);
            let status = present_detailed_outcome(detailed);
            project_outcome(detailed)
        }
        TerminalRead.show(selected) => inspect_application(selected);
        TerminalRead.latest(workspace, path) => latest_application(workspace, path);
    };
}

public flow run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Approval,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    return production(args, false);
}

public flow run_once(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Approval,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    return production(args, true);
}

// Console-only: this module imports no work, inference, approval or storage path.
public flow help(args: Array<string>) -> i32 {
    if args.len() > 1 || (args.len() == 1 && args[0] != "help" && args[0] != "--help") {
        println("REFUSED terminal_help accepts no arguments or one --help.");
        return 1;
    }
    println("Nomo terminal: line-oriented wrapper around the existing two-turn work chain.");
    println("terminal new --id ROOT --child-id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal continue --parent ROOT --id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal continue --latest --id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal_once new|continue OPTIONS --once REQUEST (supported non-TTY entry, native Deny profile)");
    println("terminal_help [--help]");
    println("Use one privately prepared fixed fixture/store. Root and child IDs must differ; continuation names its parent explicitly.");
    println("--latest resolves only a confirmed first parent with no second slot; explicit --parent conflicts. Native continuation admission and both confirmations still apply.");
    println("Commands: /help, /show, /exit; EOF stops. Requests:1..128 printable ASCII characters before trimming; at most32 input lines.");
    println("--once runs only the selected request and never reads a second request. A blank line is invalid, not EOF.");
    println("Interactive malformed input prints its diagnostic and returns to the prompt, consuming one of the 32 raw input lines. Admitted work failures still stop.");
    println("Only a confirmed first-turn result offers the second request. Failed, denied or uncertain work stops; no retry, refund, replay or third turn.");
    println("TTY edits require fresh native and Nomo confirmation. The supported non-TTY launcher requires --once and selects native Deny.");
    println("Non-TTY mode never reads an outer request line. Native denial returns before Nomo y/yes, so piped text cannot approve an edit.");
    println("SESSION shows configured per-turn policy and remaining turn positions in this process; these values are not durable availability or Provider usage.");
    println("/show selects only the bound root/current child. Its captured records and remaining allocation are historical, not current File observations or a continuation grant.");
    println("Existing work events show main/child, tools, preview, approval, durable intent and completion in their original order.");
    println("--cap uses steps,calls,generation,native_tokens,read_tools,scan,edit_reads,edit_read_bytes,atomic,atomic_bytes; existing whole-turn admission remains authoritative.");
    println("Default per-turn cap:13,7,47104,196608,1,4096,3,6144,1,2048. Work-chain lifetime supports at most two turns.");
    println("After interruption inspect the existing work/journal state with the bound IDs. Do not replay or infer that no edit occurred.");
    println("Host: ./scripts/local-tryout.sh terminal-help; ./scripts/local-tryout.sh terminal PREPARED_DIRECTORY new|continue OPTIONS");
    return 0;
}
