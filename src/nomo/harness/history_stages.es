module nomo.harness.history_stages;

import nomo.application.work_contract.{WorkModelStages, Pending, Failure, Completed, Summary};
import nomo.cli.harness_work_args.Work;
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.read_model_tools.work_child_turn;
import std.io.println;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.entry.harness_work_entry.{prepare_unicode, prepare_expanded_unicode, finish_history_summary, expanded_stage, ledger};

public flow prepare<S ~ WorkModelStages>(stages: S, input: Work, wide: bool) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => expanded_stage(name, state, wide);
    return prepare_expanded_unicode(input, original, log, wide) with {
        LegacyStringStages.main(value) => { resume stages.read(value); }
        LegacyStringStages.child(task, files, selected) => { resume stages.read_child(task, files, selected); }
        LegacyEditStages.plan(value) => { resume stages.plan(value); }
        LegacyEditStages.child(value) => { resume stages.propose(value); }
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}
public flow summarize<S ~ WorkModelStages>(stages: S, completed: Completed, wide: bool) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => expanded_stage(name, state, wide);
    return finish_history_summary(completed, log) with {
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}

// Legacy entries retain their original preparation and native child allowance.
public flow prepare_legacy<S ~ WorkModelStages>(stages: S, input: Work) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => { println("STAGE " + name); ledger(state); };
    return prepare_unicode(input, original, log) with {
        LegacyStringStages.main(value) => { resume stages.read(value); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume stages.plan(value); }
        LegacyEditStages.child(value) => { resume stages.propose(value); }
        LegacyEditStages.aggregate(value) => { resume stages.summarize(value); }
    };
}
public flow summarize_legacy<S ~ WorkModelStages>(stages: S, value: Completed) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => { println("STAGE " + name); ledger(state); };
    return finish_history_summary(value, log) with {
        LegacyEditStages.aggregate(item) => { resume stages.summarize(item); }
    };
}
