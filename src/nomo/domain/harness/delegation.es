module nomo.domain.harness.delegation;

import nomo.domain.conversation.{TraceRole, TraceKind};
import nomo.domain.conversation.TraceEvent;
import nomo.domain.limits.{context_bytes, message_bytes};
import nomo.domain.text.{input_error, text_printable};
import std.text.{char_count, split, starts_with, trim};

public enum DelegationStatus {
    Completed,
    Refused
}

impl DelegationStatus {
    public flow wire(self) -> string ![] {
        return match self {
            DelegationStatus.Completed => "completed",
            DelegationStatus.Refused => "refused"
        };
    }

    public flow parse(raw: string) -> DelegationStatus ![] {
        return match raw {
            "completed" => DelegationStatus.Completed,
            "refused" => DelegationStatus.Refused,
            _ => abort("invalid DelegationStatus spelling: " + raw)
        };
    }
}

public enum ExchangeKind {
    Request,
    Result,
    Error,
    Consume
}

impl ExchangeKind {
    public flow wire(self) -> string ![] {
        return match self {
            ExchangeKind.Request => "request",
            ExchangeKind.Result => "result",
            ExchangeKind.Error => "error",
            ExchangeKind.Consume => "consume"
        };
    }

    public flow parse(raw: string) -> ExchangeKind ![] {
        return match raw {
            "request" => ExchangeKind.Request,
            "result" => ExchangeKind.Result,
            "error" => ExchangeKind.Error,
            "consume" => ExchangeKind.Consume,
            _ => abort("invalid ExchangeKind spelling: " + raw)
        };
    }
}

// Admission is effect-free. Err means no child, message or accounting mutation.
public flow admit(job: ProcessJob) -> Result<Reservation, string> {
    if job.maximum < 1 || job.maximum > 16 || job.spent < 0 || job.spent > job.maximum {
        return Err("invalid parent step ledger");
    }
    let invalid = task_error(job.task, job.context);
    if invalid != "" {
        return Err(invalid);
    }
    if job.maximum - job.spent < 5 {
        return Err("insufficient shared step budget");
    }
    return Ok(
        Reservation {
            job,
            child = ChildTask {
                id = "child-1",
                depth = 1,
                allowance = 3,
                task = job.task,
                context = job.context
            },
            ledger = Ledger {
                maximum = job.maximum,
                spent = job.spent + 1,
                reserved = 4
            }
        }
    );
}

flow aggregate(reservation: Reservation, result: ChildResult) -> Outcome {
    var status = DelegationStatus.Refused;
    var body = "invalid child result";
    var used: i32 = 3;
    if result.id == "child-1"
        && result.used >= 1 && result.used <= 3 && safe_text(result.text, 1152)
        && (result.status == DelegationStatus.Completed || fixed_refusal(result.text)) {
        status = result.status;
        body = result.text;
        used = result.used;
    }
    var kind = ExchangeKind.Error;
    var final = "child refused: " + body;
    if status == DelegationStatus.Completed {
        kind = ExchangeKind.Result;
        final = "child result: " + body;
    }
    // Task<=256, child body<=1152, final<=1167: three messages total<=2575.
    let messages = [
        Exchange {
            sender = Participant.Main,
            recipient = Participant.Child("child-1"),
            kind = ExchangeKind.Request,
            child_id = "child-1",
            text = reservation.child.task
        },
        Exchange {
            sender = Participant.Child("child-1"),
            recipient = Participant.Main,
            kind,
            child_id = "child-1",
            text = body
        },
        Exchange {
            sender = Participant.Main,
            recipient = Participant.Main,
            kind = ExchangeKind.Consume,
            child_id = "child-1",
            text = final
        },
    ];
    return Outcome {
        status,
        text = final,
        messages,
        ledger = Ledger {
            maximum = reservation.job.maximum,
            spent = reservation.ledger.spent + used + 1,
            reserved = 0
        }
    };
}

public flow settle(reservation: Reservation, result: ChildResult) -> Result<Outcome, string> {
    let expected = match admit(reservation.job) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if child_error(reservation.child) != "" || reservation != expected {
        return Err("invalid reservation");
    }
    return Ok(aggregate(reservation, result));
}

// HARNESS-001A: copied selected data, never Host handles or delegated authority.
public type ProcessJob = {
    task: string,
    context: Array<string>,
    maximum: i32,
    spent: i32
};

public type ChildTask = {
    id: string,
    depth: i32,
    allowance: i32,
    task: string,
    context: Array<string>
};

public type ChildResult = {
    id: string,
    status: DelegationStatus,
    text: string,
    used: i32
};

public type Ledger = {
    maximum: i32,
    spent: i32,
    reserved: i32
};

public type Exchange = {
    sender: Participant,
    recipient: Participant,
    kind: ExchangeKind,
    child_id: string,
    text: string
};

public type Outcome = {
    status: DelegationStatus,
    text: string,
    ledger: Ledger,
    messages: Array<Exchange>
};

public type Reservation = {
    job: ProcessJob,
    child: ChildTask,
    ledger: Ledger
};

public flow task_error(task: string, context: Array<string>) -> string {
    if char_count(task) == 0 || char_count(task) > message_bytes() || !text_printable(task)
        || trim(task) == "" {
        return "invalid bounded child task";
    }
    if input_error(task) != "" {
        return "invalid bounded child task";
    }
    if context.len() > 4 {
        return "invalid selected context";
    }
    var characters: usize = 0;
    @limits([Iterations(4)]) for item in context {
        if char_count(item) == 0 || char_count(item) > message_bytes() || !text_printable(item) {
            return "invalid selected context";
        }
        characters = characters + char_count(item);
    }
    if characters > context_bytes() {
        return "invalid selected context";
    }
    return "";
}

public flow child_error(task: ChildTask) -> string {
    if task.id != "child-1" || task.depth != 1 || task.allowance != 3 {
        return "invalid child envelope";
    }
    return task_error(task.task, task.context);
}

public flow fixed_refusal(text: string) -> bool {
    return text == "no prior completed context" || text == "stub failure"
        || text == "expected tool:NAME:TEXT (no extra colons)" || text == "unknown tool"
        || text == "fake tool failure" || text == "invalid stub response"
        || text == "child step limit exhausted" || text == "invalid child output";
}

public flow safe_text(text: string, maximum: usize) -> bool {
    return maximum <= message_bytes() && text != "" && char_count(text) <= maximum && text_printable(text);
}

// The only adapter in this slice: deterministic data in, deterministic data out.
public flow next(request: string, history: Array<TraceEvent>, has_result: bool, result: string) -> Reply {
    if has_result {
        return Reply.Final("stub received: " + result);
    }
    if request == "recall" || request == "recall:user" {
        let remembered = match history.iter().take(32).filter(
            event =>
            (request == "recall" && event.role == TraceRole.Tool && event.kind == TraceKind.Complete)
                || (request == "recall:user" && event.role == TraceRole.User)
        ).last() {
            Some(event) => event.text,
            None() => "",
        };
        if remembered == "" {
            return Reply.Error("no prior completed context");
        }
        return Reply.Final("remembered: " + remembered);
    }
    if request == "stub:fail" {
        return Reply.Error("stub failure");
    }
    if starts_with(request, "tool:") {
        let parts = split(request, ":");
        if parts.len() != 3 || parts[1] == "" || parts[2] == "" {
            return Reply.Error("expected tool:NAME:TEXT (no extra colons)");
        }
        return Reply.Tool(ToolName {
            name = parts[1]
        }, parts[2]);
    }
    return Reply.Final("stub: " + request);
}

public flow dispatch(name: ToolName, input: string) -> ToolResult {
    if name.name != "echo" {
        return ToolResult {
            ok = false,
            text = "unknown tool"
        };
    }
    if input == "fail" {
        return ToolResult {
            ok = false,
            text = "fake tool failure"
        };
    }
    return ToolResult {
        ok = true,
        text = input
    };
}

public type ToolName = {
    name: string
};
public enum Reply {
    Final(string),
    Tool(ToolName, string),
    Error(string)
}

public type ToolResult = {
    ok: bool,
    text: string
};

public enum Participant {
    Main,
    Child(string)
}
impl Participant {
    public flow wire(self) -> string ![] {
        return match self {
            Participant.Main => "main",
            Participant.Child(id) => id
        };
    }
}
