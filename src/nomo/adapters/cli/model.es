module nomo.adapters.cli.model;

import nomo.adapters.cli.input.{cli_request_parse_line, load_for, read_cli_parse_line};
import nomo.adapters.filesystem.workspace.{list_directory, read_legacy, search_legacy};
import nomo.bootstrap.harness.{
    emit,
    failure,
    harness_tool_chat_run_turn,
    model_tool_run_loop,
    model_turn,
    read_tool_chat_run_turn,
    reject
};
import nomo.core.conversation.State;
import nomo.domain.conversation.{TextTurn, capacity_error, charge, fresh, stop as conversation_stop};
import nomo.domain.harness.chat.{admission_error, extended_admission_error, extended_invocation, fresh_invocation};
import nomo.domain.harness.loop.{Limits, allowed_error, fresh_loop, question_error as loop_question_error};
import nomo.domain.harness.read.{question_error, read_fresh};
import nomo.domain.limits.request_bytes;
import nomo.domain.text.{input_error, text_printable, within};
import nomo.domain.workspace.{Outcome, outcome as workspace_outcome, read_contract_display};
import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.harness.harness_tool_contract.Ledger;
import std.io.{println, read_line};
import std.text.{char_count, ends_with, from_i32, len, split, starts_with, trim};

flow model_help() -> unit {
    println("Nomo model: --flow model --profile gateway-qwen --args --model qwen [--once TEXT]");
    println("Text only; model output never dispatches tools. /help, /exit, EOF; 16 input lines.");
    println("Input: 1024 raw characters; output: 512 raw characters, printable ASCII after trimming.");
    println("Context: 2048-character conservative encoded-data bound; history: 32 events / 8192 content characters.");
    println("--steps and --budget: 1..16; one attempt per turn, at most four calls / 8192 reserved tokens per invocation.");
    println("Each call has 2048 input+output tokens; gateway deadlines 120000/2000 ms, retry attempts 1.");
    println("Host failures may abort the invocation. No persistence, resume, tools or graceful cancellation.");
}

public flow run_model(args: Array<string>) -> i32 {
    let config = load_for(args, "qwen");
    if config.error != "" {
        println("error: " + config.error);
        abort("Nomo model configuration rejected");
    }
    if config.help {
        model_help();
        return 0;
    }
    var state = fresh();
    if config.once {
        let outcome = model_turn(config.request, config.steps, config.budget, state);
        if outcome.status != 0 {
            abort("Nomo model request failed; see error event");
        }
        return 0;
    }
    println("Nomo model (qwen, text-only, fresh in-memory invocation). /help or /exit.");
    var lines: i32 = 0;
    @limits([Iterations(16)]) while lines < 16 {
        let input = read_line();
        if input == "" {
            println("bye: EOF");
            return 0;
        }
        lines = lines + 1;
        if char_count(input) > request_bytes() {
            let outcome = reject(state, "input exceeds 65536 characters");
            state = outcome.state;
        }
        else {
            let command = trim(input);
            if command == "/exit" {
                println("bye: exit");
                return 0;
            }
            if command == "/help" {
                model_help();
            }
            else {
                let outcome = model_turn(input, config.steps, config.budget, state);
                state = outcome.state;
            }
        }
        if state.stopped {
            abort("Nomo model history capacity exhausted");
        }
    }
    let outcome = reject(state, "line limit reached; start a new in-memory invocation");
    state = outcome.state;
    abort("Nomo model line limit exhausted");
}

public flow run_model_tools(args: Array<string>) -> i32 {
    if args.len() > 10 {
        println("error: too many arguments");
        abort("model-tool configuration rejected");
    }
    var forwarded: Array<string> = [];
    var allowed: Array<string> = [];
    var seen = false;
    var index: usize = 0;
    @limits([Iterations(10)]) while index < args.len() {
        if args[index] == "--allow" {
            if seen || index + 1 >= args.len() {
                println("error: invalid or duplicate --allow");
                abort("model-tool configuration rejected");
            }
            if char_count(args[index + 1]) > 97 {
                println("error: allowed names exceed 97 characters");
                abort("model-tool configuration rejected");
            }
            seen = true;
            allowed = split(args[index + 1], ",");
            index = index + 2;
        } else {
            forwarded = forwarded.push(args[index]);
            if args[index] != "--help" && index + 1 < args.len() {
                forwarded = forwarded.push(args[index + 1]);
                index = index + 1;
            }
            index = index + 1;
        }
    }
    let config = load_for(forwarded, "qwen-tools");
    if config.error != "" {
        println("error: " + config.error);
        abort("model-tool configuration rejected");
    }
    if config.help {
        if seen {
            println("error: --help must be used alone");
            abort("model-tool configuration rejected");
        }
        println("Opt-in model_tools: --model qwen-tools --allow FILE[,FILE] --once QUESTION [--steps N] [--budget N]");
        println("Requires gateway-qwen-readonly profile and dedicated immutable synthetic read-only fixture; no arbitrary repository.");
        println("Question: 1..128 printable ASCII chars; 1..2 distinct allowed paths, each at most 48 chars.");
        println("At most 3 total steps, 2 model calls / 4096 reserved tokens, 1 tool / 4096 reserved scan bytes; no refunds or retry.");
        println("Read or literal search only; complete display result <=256 chars, final <=512 chars, full model data context <=2048 chars.");
        println("One shot, no persistence/resume. Host failure aborts; it does not produce a durable/recoverable outcome.");
        return 0;
    }
    if !seen || !config.once {
        println("error: model-tool entry requires --allow and --once");
        abort("model-tool configuration rejected");
    }
    var steps = config.steps;
    if config.budget < steps {
        steps = config.budget;
    }
    let limits = Limits {
        steps,
        calls = 2,
        tokens = 4096,
        scan = 4096
    };
    let result = model_tool_run_loop(config.request, allowed, limits, fresh_loop());
    if result.status != 0 {
        abort("model-tool turn failed; see outcome");
    }
    return 0;
}

flow help(unicode: bool) -> unit {
    println(if unicode {
        "Nomo model/tool harness chat: new --allow FILE[,FILE...] [--turns 4]; /help, /exit, EOF."
    } else {
        "Nomo model/tool harness chat: new --allow FILE[,FILE]; /help, /exit, EOF."
    });
    println(if unicode {
        "Limits: 2 admitted tasks by default, or 4 with --turns 4; 8 raw reads including EOF; payload <=65536 before trim, <=65538 with LF/CRLF; child/parent <=1048576 bytes, complete model contexts <=33554432."
    } else {
        "Limits: 2 admitted tasks, 8 raw reads including EOF; payload <=65536 before trim, <=65538 with LF/CRLF; child/parent <=1048576 bytes, complete model contexts <=33554432."
    });
    println(if unicode {
        "Default maximum: 14 steps / 8 calls / 16384 output-token allowance / 2 tools / 32768 scan; --turns 4: 28 / 16 / 32768 / 4 / 65536. Allowances are not measured usage."
    } else {
        "Invocation maximum: 14 steps / 8 calls / 16384 token allowance / 2 read-or-search tools / 8192 scan allowance; allowances are not measured usage."
    });
    println(if unicode {
        "Each turn reserves 7/4/8192/1/4096 before work. Only the immediately preceding successful task, child/tool result and answer are carried forward, as data, never replayed actions."
    } else {
        "Each turn reserves 7/4/8192/1/4096 before work. Prior successful delegated task, child/tool result and parent answer are data, never replayed actions."
    });
    println("Read size is checked after reading. One serial depth-one child per turn; fresh in-memory only. No resume, writes, commands, recursion or live setup. Host aborts may leave reservations unresolved.");
}

flow displayed_maximum(unicode: bool, maximum: Ledger) -> Ledger {
    return if unicode {
        maximum
    } else {
        Ledger {
            steps = 14,
            calls = 8,
            tokens = 16384,
            tools = 2,
            scan = 8192
        }
    };
}

flow ledger(prefix: string, state: Ledger, maximum: Ledger) -> unit {
    println(
        prefix + "LEDGER steps=" + from_i32(state.steps) + "/" + from_i32(maximum.steps) + " calls="
            + from_i32(state.calls) + "/" + from_i32(maximum.calls) + " tokens=" + from_i32(state.tokens)
            + "/" + from_i32(maximum.tokens) + " tools=" + from_i32(state.tools) + "/"
            + from_i32(maximum.tools) + " scan=" + from_i32(state.scan) + "/" + from_i32(maximum.scan)
            + " reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0"
    );
}

flow stop(reason: string, lines: i32, state: Invocation, unicode: bool) -> unit {
    println("STOP " + reason + " turns=" + from_i32(state.admitted) + " lines=" + from_i32(lines));
    ledger("", state.usage, displayed_maximum(unicode, state.maximum));
}

flow refused(error: string, unicode: bool) -> i32 {
    println("REFUSED " + error);
    let state = fresh_invocation();
    ledger("", read_fresh(), displayed_maximum(unicode, state.maximum));
    return 1;
}

flow line_error(raw: string, unicode: bool) -> string {
    let size = if unicode {
        len(raw)
    } else {
        char_count(raw)
    };
    let framing: usize = if ends_with(raw, "\r\n") {
        2
    } else {
        if ends_with(raw, "\n") {
            1
        } else {
            0
        }
    };
    if size > 65538 || size - framing > request_bytes() {
        return if unicode {
            "raw input exceeds 65536 UTF-8 bytes plus LF/CRLF"
        } else {
            "raw input exceeds 65536 characters plus LF/CRLF"
        };
    }
    return "";
}

flow loop(allowed: Array<string>, initial: Invocation, unicode: bool, extended: bool) -> i32 {
    var state = initial;
    var lines: i32 = 0;
    let turn_limit = if extended {
        4
    } else {
        2
    };
    println(if unicode {
        "Nomo model/tool harness chat (fresh, non-durable). Only the immediately preceding turn is retained; /help for limits; /exit to quit."
    } else {
        "Nomo model/tool harness chat (fresh, non-durable). /help for limits; /exit to quit."
    });
    @limits([Iterations(8)]) while lines < 8 {
        lines = lines + 1;
        let raw = read_line();
        if raw == "" {
            stop("EOF", lines, state, unicode);
            return 0;
        }
        let framing = line_error(raw, unicode);
        if framing != "" {
            println("REFUSED " + framing);
        }
        else {
            match (if unicode {
                read_cli_parse_line(raw)
            } else {
                cli_request_parse_line(raw)
            }) {
                Err(error) => println("REFUSED " + error),
                Ok(command) => {
                    if command.kind == "exit" {
                        stop("exit", lines, state, unicode);
                        return 0;
                    }
                    if command.kind == "help" {
                        help(unicode);
                    }
                    else {
                        let invalid = if unicode {
                            question_error(command.text)
                        } else {
                            loop_question_error(command.text)
                        };
                        if invalid != "" {
                            println("REFUSED " + invalid);
                        }
                        else if starts_with(command.text, "/") {
                            println("REFUSED unknown slash command");
                        }
                        else {
                            if state.admitted >= turn_limit {
                                println("REFUSED turn limit reached");
                                stop("turn limit", lines, state, unicode);
                                return 1;
                            }
                            let capacity = if extended {
                                extended_admission_error(state.usage)
                            } else {
                                admission_error(state.usage, state.maximum)
                            };
                            if capacity != "" {
                                println("REFUSED " + capacity);
                                stop("budget", lines, state, unicode);
                                return 1;
                            }
                            println("TURN " + from_i32(state.admitted + 1) + " USER " + command.text);
                            let result = if unicode {
                                read_tool_chat_run_turn(command.text, allowed, state)
                            } else {
                                harness_tool_chat_run_turn(command.text, allowed, state)
                            };
                            if !result.resolved {
                                return 1;
                            }
                            state = result.state;
                            ledger(
                                "TURN " + from_i32(state.admitted)
                                    + " ",
                                state.usage,
                                displayed_maximum(unicode, state.maximum)
                            );
                            if result.status != 0 {
                                stop("turn failed", lines, state, unicode);
                                return 1;
                            }
                        }
                    }
                },
            };
        }
    }
    println("REFUSED input read limit reached; start a new in-memory invocation");
    stop("input limit", lines, state, unicode);
    return 1;
}

public flow run_mode(args: Array<string>, unicode: bool) -> i32 {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        help(unicode);
        return 0;
    }
    let usage = if unicode {
        "expected new --allow FILE[,FILE...] [--turns 4] or standalone help"
    } else {
        "expected new --allow FILE[,FILE] or standalone help"
    };
    if (unicode && args.len() != 3 && args.len() != 5) || (!unicode && args.len() != 3) {
        return refused(usage, unicode);
    }
    if args[0] != "new" || args[1] != "--allow" {
        return refused(usage, unicode);
    }
    if unicode && args.len() == 5 && (args[3] != "--turns" || args[4] != "4") {
        return refused("only --turns 4 is supported", true);
    }
    if (unicode && !within(args[2], 195)) || (!unicode && char_count(args[2]) > 97) {
        return refused(
            if unicode {
                "raw allowlist exceeds 195 UTF-8 bytes"
            } else {
                "raw allowlist exceeds 97 characters"
            },
            unicode
        );
    }
    let allowed = split(args[2], ",");
    let invalid = allowed_error(allowed);
    if invalid != "" {
        return refused(invalid, unicode);
    }
    let extended = unicode && args.len() == 5;
    return loop(allowed, if extended {
        extended_invocation()
    } else {
        fresh_invocation()
    }, unicode, extended);
}

public type Request = {
    operation: string,
    files: Array<string>,
    literal: string
};

public type Session = {
    history: State,
    reserved: usize
};

public type ToolTurn = {
    state: Session,
    status: i32
};

public flow fresh_tools() -> Session {
    return Session {
        history = fresh(),
        reserved = 0
    };
}

// Reserve the worst-case two-file scan before any attempted turn; no refunds.
// This separate byte ledger survives alongside the existing conversation budget.
public flow tool_turn(raw: string, maximum: i32, budget: i32, previous: Session) -> ToolTurn {
    if previous.history.stopped {
        return ToolTurn {
            state = previous,
            status = 4
        };
    }
    if previous.reserved > 4096 {
        let failed = failure(conversation_stop(previous.history), "invocation scan reservation exhausted", 4);
        return ToolTurn {
            state = previous {
                history = failed.state
            },
            status = 4
        };
    }
    let reservation = previous.reserved + 4096;
    let result = perform_turn(raw, maximum, budget, previous.history);
    return ToolTurn {
        state = Session {
            history = result.state,
            reserved = reservation
        },
        status = result.status
    };
}

flow completed_reply(state: State) -> string {
    let event = state.events[state.events.len() - 1];
    if event.role != "tool" || event.kind != "complete" {
        abort("scripted Provider requires a completed result");
    }
    return "read-only result: " + event.text;
}

// Explicit scripted Provider protocol only. TextModel output never enters here.
public flow dispatch(request: Request) -> Outcome {
    if request.operation == "read" && request.files.len() == 1 && request.literal == "" {
        return read_contract_display(read_legacy(request.files[0]));
    }
    if request.operation == "list" && request.files.len() == 1 && request.literal == "" {
        return read_contract_display(list_directory(request.files[0]));
    }
    if request.operation == "search" {
        return read_contract_display(search_legacy(request.files, request.literal));
    }
    return workspace_outcome("refused", "unsupported operation or arguments", 0);
}

flow perform_turn(raw: string, maximum: i32, budget: i32, previous: State) -> TextTurn {
    if previous.stopped {
        return TextTurn {
            state = previous,
            status = 4
        };
    }
    let invalid = input_error(raw);
    if invalid != "" {
        return reject(previous, invalid);
    }
    // The shared validator trims for stub/model input; this protocol uses raw.
    if !text_printable(raw) {
        return reject(previous, "expected printable ASCII single-line input");
    }
    let parts = split(raw, ":");
    if parts.len() < 2 || parts.len() > 3 {
        return reject(previous, "expected read:FILE, list:DIR or search:FILE[,FILE]:LITERAL");
    }
    let operation = parts[0];
    let files = split(parts[1], ",");
    var literal = "";
    if parts.len() == 3 {
        literal = parts[2];
    }
    if (operation != "read" && operation != "list" && operation != "search") || (
        operation != "search"
            && parts.len() != 2
    ) || (operation == "search" && parts.len() != 3) {
        return reject(previous, "unsupported operation or arguments");
    }
    let full = capacity_error(previous, 4, 2 * char_count(raw) + 2304);
    if full != "" {
        return failure(conversation_stop(previous), full, 4);
    }
    var state = emit(previous, "user", "input", "", raw);
    if maximum < 1 || state.spent >= budget {
        return failure(state, "invocation step budget exhausted", 4);
    }
    state = charge(state);
    state = emit(state, "model", "request", operation, raw);
    if maximum < 2 || state.spent >= budget {
        return failure(state, "invocation step budget exhausted before tool", 4);
    }
    state = charge(state);
    let result = dispatch(Request {
        operation,
        files,
        literal
    });
    let data = result.status + ": " + result.text;
    // Refusals are recorded, but never represented as completed successful tools.
    if result.status != "complete" && result.status != "truncated" {
        return TextTurn {
            state = emit(state, "tool", "error", operation, data),
            status = 3
        };
    }
    state = emit(state, "tool", "complete", operation, data);
    if maximum < 3 || state.spent >= budget {
        return failure(state, "invocation step budget exhausted before final", 4);
    }
    state = charge(state);
    // Deterministic Provider consumes the completed result as data, never parses it.
    return TextTurn {
        state = emit(state, "assistant", "final", "", completed_reply(state)),
        status = 0
    };
}

public flow run_tools(args: Array<string>) -> i32 {
    let config = load_for(args, "scripted");
    if config.error != "" {
        println("error: " + config.error);
        abort("read-only configuration rejected");
    }
    if config.help {
        println("Read-only synthetic-workspace entry: --model scripted --once read:FILE|list:DIR|search:FILE[,FILE]:LITERAL");
        println("Requires an explicit scoped read-only profile; no default root, recursion, write, shell, live model or retry.");
        println("Accepted API limits: whole-file reads and opaque directory entries; admitted small immutable fixtures only.");
        return 0;
    }
    if !config.once {
        println("error: read-only entry requires --once");
        abort("read-only configuration rejected");
    }
    let result = tool_turn(config.request, config.steps, config.budget, fresh_tools());
    if result.status != 0 {
        abort("read-only turn failed; see outcome");
    }
    return 0;
}
