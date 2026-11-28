module nomo.adapters.cli.checks;

import nomo.domain.sessions.work.wire_check_output;
import nomo.domain.sessions.work.CheckSlot;
import nomo.domain.sessions.work.{CheckState, CheckOutcome};
import nomo.adapters.storage.chat.record_check;
import nomo.adapters.storage.check_lifecycle.{ContinuousCheck, FirstCheck, FollowupCheck, load, save};
import nomo.adapters.storage.checks.{history_check_guard_finish, history_check_guard_start};
import nomo.adapters.storage.followup_checks.{history_followup_check_guard_finish, history_followup_check_guard_start};
import nomo.adapters.storage.session_records.event_policy_load;
import nomo.adapters.storage.work_admission.continuous_work_load;
import nomo.application.resources.PolicyRoot;
import nomo.application.sessions.ports.CheckLifecycle;
import nomo.domain.sessions.event_codec.Policy;
import nomo.domain.sessions.work.{CapturedCheckOutput, ExecutedCheck};
import nomo.domain.wire.{ascii_json, encode};
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println, read_line};
import std.json.parse;

// JSON string escapes make line controls and invisible Unicode safe to print,
// and let a reader reconstruct the stored streams without guessing markers.
public flow render(value: CapturedCheckOutput) -> Result<string, string> {
    let json = match encode(
        wire_check_output(value),
        "check output conversion refused",
        "check output encoding refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return ascii_json(
        json,
        262144,
        "check output encoding exceeds bound",
        "check output display exceeds bound"
    );
}

public flow show(slot: CheckSlot, selected: Option<Selection>) -> Result<bool, string> ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let check = match selected {
        Some(value) => value,
        None() => {
            println("CHECK OUTPUT " + slot.wire() + " unavailable: no check");
            return Ok(true);
        }
    };
    if !check.phase.is_complete() {
        println("CHECK OUTPUT " + slot.wire() + " unavailable: check unresolved");
        return Ok(true);
    }
    let saved = match load(slot, check.id, check.digest) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match saved {
        None() => println("CHECK OUTPUT " + slot.wire() + " unavailable: no recorded output"),
        Some(value) => {
            let json = match render(value) {
                Ok(text) => text,
                Err(error) => {
                    return Err(error);
                }
            };
            println("CHECK OUTPUT " + json);
        }
    }
    return Ok(true);
}

// Internal launcher boundary. It is not exposed as a user command; the
// launcher retains the session lock while it runs the selected offline check.
public flow save_check_output(args: Array<string>, slot: CheckSlot) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    if args.len() != 5 || (slot != CheckSlot.First && slot != CheckSlot.Followup) {
        println("REFUSED invalid internal check action");
        return 1;
    }
    if (args[3] != "true" && args[3] != "false") || (args[4] != "true" && args[4] != "false") {
        println("REFUSED invalid output truncation flags");
        return 1;
    }
    let raw = read_line();
    let parsed = match parse(raw) {
        Ok(item) => item,
        _ => {
            println("REFUSED invalid output transfer");
            return 1;
        }
    };
    let message = Message.new(parsed);
    let typed: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match typed {
        Some(item) => item.body,
        None() => {
            println("REFUSED invalid output fields");
            return 1;
        }
    };
    if fields.len() != 2 {
        println("REFUSED invalid output field count");
        return 1;
    }
    let value = CapturedCheckOutput {
        format = 1,
        slot,
        id = args[1],
        digest = args[2],
        stdout = fields[0],
        stderr = fields[1],
        stdout_truncated = args[3] == "true",
        stderr_truncated = args[4] == "true"
    };
    match save(value) {
        Ok(_) => {
            println("CHECK OUTPUT SAVED");
            return 0;
        }
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    }
}

public flow run_slot(args: Array<string>, followup: bool) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    if args.len() == 3 && args[0] == "start" {
        match (
            if followup {
                history_followup_check_guard_start(args[1], args[2])
            } else {
                history_check_guard_start(args[1], args[2])
            }
        ) {
            Ok(_) => {
                println("CHECK RESERVED");
                return 0;
            }
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        }
    }
    if args.len() == 5 && args[0] == "finish" {
        let outcome = match CheckOutcome.parse(args[3], args[4]) {
            Ok(value) => value,
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        };
        match (
            if followup {
                history_followup_check_guard_finish(args[1], args[2], outcome)
            } else {
                history_check_guard_finish(args[1], args[2], outcome)
            }
        ) {
            Ok(_) => {
                println("CHECK SAVED");
                return 0;
            }
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        }
    }
    if args.len() == 5 && args[0] == "output" {
        return save_check_output(args, if followup {
            CheckSlot.Followup
        } else {
            CheckSlot.First
        });
    }
    println("REFUSED invalid internal check action");
    return 1;
}

public flow history_check_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    return run_slot(args, false);
}

// Internal launcher boundary; the caller holds the session lock.
public flow history_followup_check_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    return run_slot(args, true);
}

// Called only by the launcher while it retains the session lock. No model or
// workspace capability is granted to this checkpoint process.
public flow run_mode(args: Array<string>, followup: bool) -> i32 ![
    Console,
    Memory,
    Fs.read<PolicyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    if args.len() < 4 || args[0] != "--policy-binding" {
        println("REFUSED check policy binding required");
        return 1;
    }
    let policy = match event_policy_load() {
        Ok(item) => item,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    let binding = args[1];
    var additional = false;
    if followup {
        let extra = match continuous_work_load(binding) {
            Ok(value) => value,
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        };
        match extra {
            Some(item) => {
                if item.value.current.core.id == args[3] {
                    additional = true;
                }
            },
            None() => (),
        }
    }
    if additional {
        return run_lifecycle(ContinuousCheck {
            redaction = policy,
            binding
        }, args, policy, binding);
    }
    if followup {
        return run_lifecycle(FollowupCheck {
            redaction = policy,
            binding
        }, args, policy, binding);
    }
    return run_lifecycle(FirstCheck {
        redaction = policy,
        binding
    }, args, policy, binding);
}

flow run_lifecycle<L ~ CheckLifecycle>(lifecycle: L, args: Array<string>, policy: Policy, binding: string) -> i32 {
    if args.len() == 5 && args[2] == "start" {
        match lifecycle.start(args[3], args[4]) {
            Ok(_) => {
                println("CHECK RESERVED");
                return 0;
            }
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        }
    }
    if args.len() == 9 && (args[2] == "finish" || args[2] == "independent") {
        let outcome = match CheckOutcome.parse(args[5], args[6]) {
            Ok(value) => value,
            Err(error) => {
                println("REFUSED " + error);
                return 1;
            }
        };
        if (args[7] != "true" && args[7] != "false") || (args[8] != "true" && args[8] != "false") {
            println("REFUSED invalid truncation flags");
            return 1;
        }
        let parsed = match parse(read_line()) {
            Ok(item) => item,
            _ => {
                println("REFUSED invalid check output transfer");
                return 1;
            }
        };
        let message: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
        let fields = match message {
            Some(item) => item.body,
            None() => {
                println("REFUSED invalid check output fields");
                return 1;
            }
        };
        if fields.len() != 2 {
            println("REFUSED invalid check output field count");
            return 1;
        }
        let independent = args[2] == "independent";
        if !independent {
            let result = ExecutedCheck {
                outcome,
                stdout = fields[0],
                stderr = fields[1],
                stdout_truncated = args[7] == "true",
                stderr_truncated = args[8] == "true"
            };
            match lifecycle.finish(args[3], args[4], result) {
                Ok(_) => (),
                Err(error) => {
                    println("REFUSED " + error);
                    return 1;
                }
            }
        }
        match record_check(
            args[3],
            args[4],
            outcome,
            fields[0],
            fields[1],
            args[7] == "true",
            args[8] == "true",
            independent,
            policy,
            binding
        ) {
            Ok(_) => {
                println(if independent {
                    "INDEPENDENT CHECK SAVED"
                } else {
                    "CHECK AND SELECTED OUTPUT SAVED"
                });
                return 0;
            }
            Err(error) => {
                println("REFUSED check may be saved; timeline incomplete: " + error);
                return 1;
            }
        }
    }
    println("REFUSED invalid check action");
    return 1;
}

public flow recoverable_history_check_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<PolicyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    return run_mode(args, false);
}

public flow recoverable_history_followup_check_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<PolicyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    return run_mode(args, true);
}

public type Selection = {
    phase: CheckState,
    id: string,
    digest: string
};
