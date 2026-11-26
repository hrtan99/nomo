module nomo.domain.process.observations;

import std.codec.text.{utf8_decode, Replace};
import nomo.domain.process.jobs.JobEvent;

public enum ProcessEvent { Output(bytes, bytes), Exited(i32, bytes, bytes), Stopped(bytes, bytes) }

flow display(value: bytes) -> string {
    return match utf8_decode(value, Replace) { Ok(text) => text, Err(_) => { abort("process output conversion failed"); } };
}

public flow observed(job: string, call: i64, value: ProcessEvent) -> JobEvent {
    return match value {
        ProcessEvent.Output(stdout, stderr) => JobEvent { job, call, phase = "output", exit_code = None(), stdout = display(stdout), stderr = display(stderr), stdout_bytes = stdout, stderr_bytes = stderr },
        ProcessEvent.Exited(code, stdout, stderr) => JobEvent { job, call, phase = "exited", exit_code = Some(code), stdout = display(stdout), stderr = display(stderr), stdout_bytes = stdout, stderr_bytes = stderr },
        ProcessEvent.Stopped(stdout, stderr) => JobEvent { job, call, phase = "stopped", exit_code = None(), stdout = display(stdout), stderr = display(stderr), stdout_bytes = stdout, stderr_bytes = stderr }
    };
}

public flow recorded_phase(previous: string, observed: string) -> string {
    return if observed == "output" { previous } else { observed };
}
