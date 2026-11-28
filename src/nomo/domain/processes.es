module nomo.domain.processes;

import nomo.domain.wire.{value as json_value, fields};
import std.json.JsonValue;
import std.codec.text.{Replace, utf8_decode};

// Old project jobs have a workspace owner and a last saved observation, not a
// conversation owner or a reconnectable native process capability.
public type ArchivedProcessJob = {
    id: string,
    workspace: string,
    arguments: Array<string>,
    phase: ArchivedJobPhase,
    exit_code: Option<i32>,
    output_bytes: usize,
    parts: usize,
    original: string
};

// Old project jobs have a workspace owner and a last saved observation, not a
// conversation owner or a reconnectable native process capability.
public type ArchivedOutput = {
    job: string,
    part: usize,
    next_part: Option<usize>,
    total_bytes: usize,
    data: bytes
};

public type StartRequest = {
    operation: ProcessOperation,
    program: string,
    arguments: Array<string>
};

public type JobRequest = {
    operation: ProcessOperation,
    job: string,
    handle: string
};

public type ReadRequest = {
    operation: ProcessOperation,
    job: string,
    handle: string,
    max_bytes: usize
};

public type WriteRequest = {
    operation: ProcessOperation,
    job: string,
    handle: string,
    input: string
};

public type InputResult = {
    job: string,
    operation: ProcessOperation
};

public enum ProcessEvent {
    Output(bytes, bytes),
    Exited(i32, bytes, bytes),
    Stopped(bytes, bytes)
}

flow display(value: bytes) -> string {
    return match utf8_decode(value, Replace) {
        Ok(text) => text,
        Err(_) => abort("process output conversion failed"),
    };
}

public flow observed(job: string, call: i64, value: ProcessEvent) -> ProcessOutput {
    return match value {
        ProcessEvent.Output(stdout, stderr) => ProcessOutput {
            job,
            call,
            phase = JobEventKind.Output,
            exit_code = None(),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        },
        ProcessEvent.Exited(code, stdout, stderr) => ProcessOutput {
            job,
            call,
            phase = JobEventKind.Exited,
            exit_code = Some(code),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        },
        ProcessEvent.Stopped(stdout, stderr) => ProcessOutput {
            job,
            call,
            phase = JobEventKind.Stopped,
            exit_code = None(),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        }
    };
}

public flow recorded_phase(previous: JobPhase, observed: JobEventKind) -> JobPhase ![] {
    return match observed {
        JobEventKind.Output => previous,
        JobEventKind.Exited => JobPhase.Exited,
        JobEventKind.Stopped => JobPhase.Stopped
    };
}

// phase is the last recorded Host observation, not a claim of current liveness.
public type ProcessJob = {
    id: string,
    session: string,
    program: string,
    arguments: Array<string>,
    handle: string,
    phase: JobPhase
};

public type ProcessOutput = {
    job: string,
    call: i64,
    phase: JobEventKind,
    exit_code: Option<i32>,
    stdout: string,
    stderr: string,
    stdout_bytes: bytes,
    stderr_bytes: bytes
};

public enum ProcessOperation {
    Start,
    Reconnect,
    Read,
    Write,
    CloseStdin,
    Stop
}

impl ProcessOperation {
    public flow wire(self) -> string ![] {
        return match self {
            ProcessOperation.Start => "start",
            ProcessOperation.Reconnect => "reconnect",
            ProcessOperation.Read => "read",
            ProcessOperation.Write => "write",
            ProcessOperation.CloseStdin => "close_stdin",
            ProcessOperation.Stop => "stop"
        };
    }

    public flow parse(raw: string) -> ProcessOperation ![] {
        return match raw {
            "start" => ProcessOperation.Start,
            "reconnect" => ProcessOperation.Reconnect,
            "read" => ProcessOperation.Read,
            "write" => ProcessOperation.Write,
            "close_stdin" => ProcessOperation.CloseStdin,
            "stop" => ProcessOperation.Stop,
            _ => abort("invalid ProcessOperation spelling: " + raw)
        };
    }
}

public enum JobPhase {
    Starting,
    Started,
    Exited,
    Stopped
}

impl JobPhase {
    public flow wire(self) -> string ![] {
        return match self {
            JobPhase.Starting => "starting",
            JobPhase.Started => "started",
            JobPhase.Exited => "exited",
            JobPhase.Stopped => "stopped"
        };
    }

    public flow parse(raw: string) -> JobPhase ![] {
        return match raw {
            "starting" => JobPhase.Starting,
            "started" => JobPhase.Started,
            "exited" => JobPhase.Exited,
            "stopped" => JobPhase.Stopped,
            _ => abort("invalid JobPhase spelling: " + raw)
        };
    }
}

public enum JobEventKind {
    Output,
    Exited,
    Stopped
}

impl JobEventKind {
    public flow wire(self) -> string ![] {
        return match self {
            JobEventKind.Output => "output",
            JobEventKind.Exited => "exited",
            JobEventKind.Stopped => "stopped"
        };
    }

    public flow parse(raw: string) -> JobEventKind ![] {
        return match raw {
            "output" => JobEventKind.Output,
            "exited" => JobEventKind.Exited,
            "stopped" => JobEventKind.Stopped,
            _ => abort("invalid JobEventKind spelling: " + raw)
        };
    }
}

public enum ArchivedJobPhase {
    Starting,
    Running,
    Completed,
    Exited,
    Stopped,
    Unknown
}

impl ArchivedJobPhase {
    public flow wire(self) -> string ![] {
        return match self {
            ArchivedJobPhase.Starting => "starting",
            ArchivedJobPhase.Running => "running",
            ArchivedJobPhase.Completed => "completed",
            ArchivedJobPhase.Exited => "exited",
            ArchivedJobPhase.Stopped => "stopped",
            ArchivedJobPhase.Unknown => "unknown"
        };
    }

    public flow parse(raw: string) -> ArchivedJobPhase ![] {
        return match raw {
            "starting" => ArchivedJobPhase.Starting,
            "running" => ArchivedJobPhase.Running,
            "completed" => ArchivedJobPhase.Completed,
            "exited" => ArchivedJobPhase.Exited,
            "stopped" => ArchivedJobPhase.Stopped,
            "unknown" => ArchivedJobPhase.Unknown,
            _ => abort("invalid ArchivedJobPhase spelling: " + raw)
        };
    }
}

public spec ProcessWire {
    flow wire(self) -> JsonValue ![];
}

impl StartRequest ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("operation", JsonValue.String(self.operation.wire()))]);
    }
}

impl JobRequest ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("operation", JsonValue.String(self.operation.wire()))]);
    }
}

impl ReadRequest ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("operation", JsonValue.String(self.operation.wire()))]);
    }
}

impl WriteRequest ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("operation", JsonValue.String(self.operation.wire()))]);
    }
}

impl InputResult ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(
            json_value(self),
            [("operation", JsonValue.String(self.operation.wire())), ("status", JsonValue.String("completed"))]
        );
    }
}

impl ProcessJob ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("phase", JsonValue.String(self.phase.wire()))]);
    }
}

impl ProcessOutput ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("phase", JsonValue.String(self.phase.wire()))]);
    }
}

impl ArchivedProcessJob ~ ProcessWire {
    public flow wire(self) -> JsonValue ![] {
        return fields(json_value(self), [("phase", JsonValue.String(self.phase.wire()))]);
    }
}
