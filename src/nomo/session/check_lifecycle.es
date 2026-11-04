module nomo.session.check_lifecycle;

import nomo.application.check_contract.{CheckResult, CheckLifecycle, CheckFacts, CheckFactsReader};
import nomo.application.history_contract.CheckOutput;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_check_store.{start, finish, abandon, load, Frame};
import nomo.session.recoverable_followup_check_store.{start as start_followup, finish as finish_followup, abandon as abandon_followup, load as load_followup};
import nomo.session.continuous_work.{start_check, finish_check, abandon_check};
import nomo.session.event_text_codec.decode;

public type FirstCheck = { redaction: Policy, binding: string };
public type FollowupCheck = { redaction: Policy, binding: string };
public type ContinuousCheck = { redaction: Policy, binding: string };
flow captured(id: string, digest: string, phase: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy) -> Result<CheckFacts, string> {
    var output: Option<CheckOutput> = None();
    if phase == "complete" {
        let out = match decode(stdout, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
        let err = match decode(stderr, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
        output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = out_truncated, stderr_truncated = err_truncated });
    }
    return Ok(CheckFacts { id = id, digest = digest, phase = phase, outcome = outcome, exit_code = exit_code, output = output });
}
flow frame_facts(frame: Frame, policy: Policy) -> Result<Option<CheckFacts>, string> {
    let check = frame.check;
    return match captured(check.id, check.digest, check.phase, check.outcome, check.exit_code, frame.stdout, frame.stderr, frame.stdout_truncated, frame.stderr_truncated, policy) { Ok(value) => Ok(Some(value)), Err(error) => Err(error) };
}
impl FirstCheck ~ CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> {
        return match load(self.redaction, self.binding) { Ok(Some(item)) => frame_facts(item.value, self.redaction), Ok(None()) => Ok(None()), Err(error) => Err(error) };
    }
}
impl FollowupCheck ~ CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> {
        return match load_followup(self.redaction, self.binding) { Ok(Some(item)) => frame_facts(item.value, self.redaction), Ok(None()) => Ok(None()), Err(error) => Err(error) };
    }
}
impl FirstCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return start(id, digest, self.redaction, self.binding); }
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return finish(id, digest, result.outcome, result.exit_code, result.stdout, result.stderr, result.stdout_truncated, result.stderr_truncated, self.redaction, self.binding); }
    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return abandon(id, self.redaction, self.binding); }
}
impl FollowupCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return start_followup(id, digest, self.redaction, self.binding); }
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return finish_followup(id, digest, result.outcome, result.exit_code, result.stdout, result.stderr, result.stdout_truncated, result.stderr_truncated, self.redaction, self.binding); }
    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return abandon_followup(id, self.redaction, self.binding); }
}
impl ContinuousCheck ~ CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return match start_check(self.binding, id, digest) { Ok(_) => Ok(true), Err(error) => Err(error) }; }
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return match finish_check(self.binding, id, digest, result.outcome, result.exit_code, result.stdout, result.stderr, result.stdout_truncated, result.stderr_truncated, self.redaction) { Ok(_) => Ok(true), Err(error) => Err(error) }; }
    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return abandon_check(self.binding, id); }
}
