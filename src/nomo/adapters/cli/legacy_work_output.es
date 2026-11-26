module nomo.adapters.cli.legacy_work_output;

import std.io.{println, IOError as ConsoleError};
import nomo.application.work.output.WorkOutputSink;
import nomo.adapters.cli.legacy.edit_context.{display, recorded};
import nomo.application.harness.work.controller.historical_ledger_text;
import nomo.harness.harness_work_contract.Ledger;
import nomo.domain.mutations.edit_contract.Selector;

public type LegacyWorkOutput = {};
impl LegacyWorkOutput ~ WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<ConsoleError>] {
        if line != "POST_EDIT context" && line != "POST_EDIT aggregate" && line != "POST_EDIT events" && line != "POST_EDIT persist" { println(line); }
    }
    flow diagnostic(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
    flow recorded(self, selected: Selector) -> unit ![Error<ConsoleError>, Error<IndexError>] { recorded(selected); }
    flow ledger(self, state: Ledger, wide: bool, high_input: bool) -> unit ![Error<ConsoleError>] {
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
    }
    flow refused(self, error: string) -> i32 ![Error<ConsoleError>] { println("REFUSED " + error); return 1; }
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool, high_input: bool) -> i32 ![Error<ConsoleError>, Error<IndexError>] {
        display("FINAL ", answer);
        println(saved);
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
        return 0;
    }
}
