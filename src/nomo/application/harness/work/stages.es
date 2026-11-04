module nomo.application.harness.work.stages;

import nomo.application.work.request.WorkRequest;
import nomo.application.work.ports.{Pending, Failure, Completed, Summary};
import nomo.application.harness.work.ports.WorkModelStages;
import nomo.application.harness.work.controller.{prepare_unicode, prepare_expanded_unicode, finish_history_summary, expanded_stage, historical_stage};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.read_model_tools.work_child_turn;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.model.harness_progress.HarnessProgress;

public flow prepare<S ~ WorkModelStages>(stages: S, input: WorkRequest, wide: bool) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    let log: (string, Ledger) -> unit ![HarnessProgress.write] = (name: string, state: Ledger) => expanded_stage(name, state, wide);
    return prepare_expanded_unicode(input, original, log, wide) with {
        LegacyStringStages.main(value) => { resume stages.read(value); }
        LegacyStringStages.child(task, files, selected) => { resume stages.read_child(task, files, selected); }
        LegacyEditStages.plan(value) => { resume stages.plan(value); }
        LegacyEditStages.child(value) => { resume stages.propose(value); }
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}

public flow summarize<S ~ WorkModelStages>(stages: S, completed: Completed, wide: bool) -> Result<Summary, Failure> {
    let log: (string, Ledger) -> unit ![HarnessProgress.write] = (name: string, state: Ledger) => expanded_stage(name, state, wide);
    return finish_history_summary(completed, log) with {
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}

public flow prepare_legacy<S ~ WorkModelStages>(stages: S, input: WorkRequest) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    let log: (string, Ledger) -> unit ![HarnessProgress.write] = (name: string, state: Ledger) => historical_stage(name, state);
    return prepare_unicode(input, original, log) with {
        LegacyStringStages.main(value) => { resume stages.read(value); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume stages.plan(value); }
        LegacyEditStages.child(value) => { resume stages.propose(value); }
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}

public flow summarize_legacy<S ~ WorkModelStages>(stages: S, value: Completed) -> Result<Summary, Failure> {
    let log: (string, Ledger) -> unit ![HarnessProgress.write] = (name: string, state: Ledger) => historical_stage(name, state);
    return finish_history_summary(value, log) with {
        LegacyEditStages.aggregate(item) => { resume stages.summarize(item); }
    };
}
