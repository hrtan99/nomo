module nomo.harness.harness;

import nomo.harness.harness_contract.{Job, ChildTask, ChildResult, Ledger, Exchange, Outcome, Reservation,
    task_error, child_error, safe_text, fixed_refusal};
import nomo.harness.harness_child.run as child_run;

// Admission is effect-free. Err means no child, message or accounting mutation.
public flow admit(job: Job) -> Result<Reservation, string> {
    if job.maximum < 1 || job.maximum > 16 || job.spent < 0 || job.spent > job.maximum {
        return Err("invalid parent step ledger");
    }
    let invalid = task_error(job.task, job.context);
    if invalid != "" { return Err(invalid); }
    if job.maximum - job.spent < 5 { return Err("insufficient shared step budget"); }
    return Ok(Reservation { job = job,
        child = ChildTask { id = "child-1", depth = 1, allowance = 3, task = job.task, context = job.context },
        ledger = Ledger { maximum = job.maximum, spent = job.spent + 1, reserved = 4 } });
}

flow aggregate(reservation: Reservation, result: ChildResult) -> Outcome {
    var status = "refused";
    var body = "invalid child result";
    var used: i32 = 3;
    if result.id == "child-1" && (result.status == "completed" || result.status == "refused") &&
        result.used >= 1 && result.used <= 3 && safe_text(result.text, 1152) &&
        (result.status == "completed" || fixed_refusal(result.text)) {
        status = result.status;
        body = result.text;
        used = result.used;
    }
    var kind = "error";
    var final = "child refused: " + body;
    if status == "completed" { kind = "result"; final = "child result: " + body; }
    // Task<=256, child body<=1152, final<=1167: three messages total<=2575.
    let messages = [
        Exchange { sender = "main", recipient = "child-1", kind = "request", child_id = "child-1", text = reservation.child.task },
        Exchange { sender = "child-1", recipient = "main", kind = kind, child_id = "child-1", text = body },
        Exchange { sender = "main", recipient = "main", kind = "consume", child_id = "child-1", text = final },
    ];
    return Outcome { status = status, text = final, messages = messages,
        ledger = Ledger { maximum = reservation.job.maximum, spent = reservation.ledger.spent + used + 1, reserved = 0 } };
}

public flow settle(reservation: Reservation, result: ChildResult) -> Result<Outcome, string> {
    let expected = match admit(reservation.job) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if child_error(reservation.child) != "" || reservation != expected { return Err("invalid reservation"); }
    return Ok(aggregate(reservation, result));
}

// Exactly one synchronous child invocation; no retry, sibling or recursive route.
public flow run(job: Job) -> Result<Outcome, string> {
    return match admit(job) {
        Err(error) => Err(error),
        Ok(reservation) => settle(reservation, child_run(reservation.child)),
    };
}
