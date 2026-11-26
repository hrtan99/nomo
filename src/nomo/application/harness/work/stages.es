module nomo.application.harness.work.stages;

import nomo.application.work.request.WorkRequest;
import nomo.domain.work.protocol.{Pending, Failure, Completed, Summary};
import nomo.application.harness.work.ports.WorkModelStages;
import nomo.application.harness.work.controller.{HarnessWorkStage, prepare_unicode, prepare_expanded_unicode, finish_history_summary, expanded_stage, historical_stage};
import nomo.application.harness.effects.harness_legacy_string_stages.{LegacyStringStages, LegacyEditStages};

public flow prepare<S ~ WorkModelStages>(stages: S, input: WorkRequest, wide: bool, high_input: bool) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    return prepare_expanded_unicode(input, original, wide, high_input) with {
        HarnessWorkStage.write(name, state) => expanded_stage(name, state, wide, high_input);
        LegacyStringStages.main(value) => stages.read(value);
        LegacyStringStages.child(task, files, selected) => stages.read_child(task, files, selected);
        LegacyEditStages.plan(value) => stages.plan(value);
        LegacyEditStages.child(value) => stages.propose(value);
        LegacyEditStages.aggregate(value) => stages.summarize(value);
    };
}

public flow summarize<S ~ WorkModelStages>(stages: S, completed: Completed, wide: bool, high_input: bool) -> Result<Summary, Failure> {
    return finish_history_summary(completed) with {
        HarnessWorkStage.write(name, state) => expanded_stage(name, state, wide, high_input);
        LegacyEditStages.aggregate(value) => stages.summarize(value);
    };
}

public flow prepare_legacy<S ~ WorkModelStages>(stages: S, input: WorkRequest) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    return prepare_unicode(input, original) with {
        HarnessWorkStage.write(name, state) => historical_stage(name, state);
        LegacyStringStages.main(value) => stages.read(value);
        LegacyStringStages.child(task, files, selected) => stages.read_child(task, files, selected);
        LegacyEditStages.plan(value) => stages.plan(value);
        LegacyEditStages.child(value) => stages.propose(value);
        LegacyEditStages.aggregate(value) => stages.summarize(value);
    };
}

public flow summarize_legacy<S ~ WorkModelStages>(stages: S, value: Completed) -> Result<Summary, Failure> {
    return finish_history_summary(value) with {
        HarnessWorkStage.write(name, state) => historical_stage(name, state);
        LegacyEditStages.aggregate(item) => stages.summarize(item);
    };
}
