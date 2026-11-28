module nomo.adapters.storage.check_lifecycle;

import nomo.adapters.storage.checks.{
    abandon,
    inspect,
    load as checks_load,
    recoverable_check_store_finish,
    recoverable_check_store_start
};
import nomo.adapters.storage.followup_checks.{
    abandon as followup_checks_abandon,
    inspect as followup_checks_inspect,
    load as followup_checks_load,
    recoverable_followup_check_store_finish,
    recoverable_followup_check_store_start
};
import nomo.adapters.storage.session_records.commit_native;
import nomo.adapters.storage.work_admission.{abandon_check, finish_check, start_check};
import nomo.application.sessions.ports.{CheckFactsReader, CheckLifecycle, Target};
import nomo.domain.limits.message_frame_bytes;
import nomo.domain.sessions.event_codec.{Policy, event_text_codec_decode};
import nomo.domain.sessions.work.{CheckFacts, CheckOutput, CheckResult};
import nomo.session.check_output.{Outputs, Record};
import nomo.session.check_store.Frame;
import std.memory.Missing;
import std.text.char_count;

public type FirstCheck = {
    redaction: Policy,
    binding: string
};

public type FollowupCheck = {
    redaction: Policy,
    binding: string
};

public type ContinuousCheck = {
    redaction: Policy,
    binding: string
};

flow captured(
    id: string,
    digest: string,
    phase: string,
    outcome: string,
    exit_code: string,
    stdout: string,
    stderr: string,
    out_truncated: bool,
    err_truncated: bool,
    policy: Policy
) -> Result<CheckFacts, string> {
    var output: Option<CheckOutput> = None();
    if phase == "complete" {
        let out = match event_text_codec_decode(stdout, policy) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        let err = match event_text_codec_decode(stderr, policy) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        output = Some(
            CheckOutput {
                stdout = out,
                stderr = err,
                stdout_truncated = out_truncated,
                stderr_truncated = err_truncated
            }
        );
    }
    return Ok(CheckFacts {
        id,
        digest,
        phase,
        outcome,
        exit_code,
        output
    });
}

flow frame_facts(frame: Frame, policy: Policy) -> Result<Option<CheckFacts>, string> {
    let check = frame.check;
    return match captured(
        check.id,
        check.digest,
        check.phase,
        check.outcome,
        check.exit_code,
        frame.stdout,
        frame.stderr,
        frame.stdout_truncated,
        frame.stderr_truncated,
        policy
    ) {
        Ok(value) => Ok(Some(value)),
        Err(error) => Err(error)
    };
}

impl FirstCheck ~ CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> {
        return match checks_load(self.redaction, self.binding) {
            Ok(Some(item)) => frame_facts(item.value, self.redaction),
            Ok(None()) => Ok(None()),
            Err(error) => Err(error)
        };
    }
}

impl FollowupCheck ~ CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> {
        return match followup_checks_load(self.redaction, self.binding) {
            Ok(Some(item)) => frame_facts(item.value, self.redaction),
            Ok(None()) => Ok(None()),
            Err(error) => Err(error)
        };
    }
}

impl FirstCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_check_store_start(id, digest, self.redaction, self.binding);
    }

    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_check_store_finish(
            id,
            digest,
            result.outcome,
            result.exit_code,
            result.stdout,
            result.stderr,
            result.stdout_truncated,
            result.stderr_truncated,
            self.redaction,
            self.binding
        );
    }

    flow abandon(self, id: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return abandon(id, self.redaction, self.binding);
    }
}

impl FollowupCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_followup_check_store_start(id, digest, self.redaction, self.binding);
    }

    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_followup_check_store_finish(
            id,
            digest,
            result.outcome,
            result.exit_code,
            result.stdout,
            result.stderr,
            result.stdout_truncated,
            result.stderr_truncated,
            self.redaction,
            self.binding
        );
    }

    flow abandon(self, id: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return followup_checks_abandon(id, self.redaction, self.binding);
    }
}

impl ContinuousCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>
    ] {
        return match start_check(self.binding, id, digest) {
            Ok(_) => Ok(true),
            Err(error) => Err(error)
        };
    }

    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return match finish_check(
            self.binding,
            id,
            digest,
            result.outcome,
            result.exit_code,
            result.stdout,
            result.stderr,
            result.stdout_truncated,
            result.stderr_truncated,
            self.redaction
        ) {
            Ok(_) => Ok(true),
            Err(error) => Err(error)
        };
    }

    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return abandon_check(self.binding, id);
    }
}

flow check_binding(slot: string, id: string, digest: string) -> string {
    if slot == "first" {
        let value = match inspect() {
            Ok(Some(item)) => item,
            _ => {
                return "completed first check required";
            }
        };
        if value.phase != "complete" || value.id != id || value.digest != digest {
            return "first check binding differs";
        }
    } else if slot == "followup" {
        let value = match followup_checks_inspect() {
            Ok(Some(item)) => item,
            _ => {
                return "completed followup check required";
            }
        };
        if value.phase != "complete" || value.id != id || value.digest != digest {
            return "followup check binding differs";
        }
    } else {
        return "unknown check output slot";
    }
    return "";
}

public flow save(value: Record) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if value.format != 1 || char_count(value.stdout) > message_frame_bytes()
        || char_count(value.stderr) > message_frame_bytes() {
        return Err("invalid check output");
    }
    let problem = check_binding(value.slot, value.id, value.digest);
    if problem != "" {
        return Err(problem);
    }
    if Outputs.Rows.get_entry(value.slot) != None() {
        return Err("check output already recorded");
    }
    match commit_native<Record>(
        Outputs.Rows,
        Target {
            store = ["Rows"],
            region = "nomo-check-output-v1",
            key = value.slot,
            label = "check output"
        },
        value,
        Missing
    ) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

public flow load(slot: string, id: string, digest: string) -> Result<Option<Record>, string> {
    let problem = check_binding(slot, id, digest);
    if problem != "" {
        return Err(problem);
    }
    let saved = Outputs.Rows.get_entry(slot);
    match saved {
        None() => {
            return Ok(None());
        }
        Some(entry) => {
            let value = entry.value;
            if value.format != 1 || value.slot != slot || value.id != id || value.digest != digest
                || char_count(value.stdout) > message_frame_bytes()
                || char_count(value.stderr) > message_frame_bytes() {
                return Err("check output record differs");
            }
            if Outputs.Rows.get_entry(slot) != saved {
                return Err("check output changed during read");
            }
            return Ok(Some(value));
        }
    }
}
