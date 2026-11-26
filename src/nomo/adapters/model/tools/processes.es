module nomo.adapters.model.tools.processes;

import nomo.application.conversation.session_context.SessionContext;
import nomo.application.processes.ports.ProcessOperations;
import nomo.domain.process.jobs.{Job as JobView, JobEvent as JobEventView, InputResult};

/// Start an allowlisted background process in the project after native approval. The handle belongs to this live Etas Host; persistence of metadata does not keep the Host alive.
public tool start_job(program: string, arguments: Array<string>) -> JobView
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.start(session, program, arguments);
}

/// Read the next native output event. This waits for output or termination; max_bytes is the per-stream bound. Original bytes accompany the display text and remain in history.
public tool read_job(job: string, max_bytes: usize) -> JobEventView
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.read(session, job, max_bytes);
}

/// Write the exact input bytes after a separate native approval. No newline is added.
public tool write_job(job: string, input: string) -> InputResult
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.write(session, job, input);
}

/// Close this job's stdin after native approval, allowing programs waiting for EOF to finish.
public tool close_job_input(job: string) -> InputResult
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.close_input(session, job);
}

/// Stop an owned background process after fresh native approval and return its actual terminal event.
public tool stop_job(job: string) -> JobEventView
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.stop(session, job);
}

/// List this conversation's saved metadata; phases do not establish current liveness.
public tool list_jobs() -> Array<JobView>
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.list(session);
}

/// Read all complete saved output events for this job without consuming Host output or replaying a process operation. This archive remains readable after restart.
public tool job_output(job: string) -> Array<JobEventView>
    ![SessionContext, ProcessOperations] {
    let session = perform SessionContext.current();
    return perform ProcessOperations.output(session, job);
}

public flow jobs(session: string) -> Array<JobView> ![ProcessOperations] {
    return perform ProcessOperations.list(session);
}
