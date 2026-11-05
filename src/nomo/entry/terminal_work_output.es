module nomo.entry.terminal_work_output;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.application.work_output.WorkOutputSink;
import nomo.entry.edit_context.{display, recorded};
import nomo.entry.harness_work_entry.{expanded_ledger_mode, simple_refused};
import nomo.harness.harness_work_contract.Ledger;
import nomo.tools.edit_contract.Selector;

public type TerminalWorkOutput = {};

impl TerminalWorkOutput ~ WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
    flow diagnostic(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
    flow recorded(self, selected: Selector) -> unit ![Error<ConsoleError>, Error<IndexError>] { recorded(selected); }
    flow ledger(self, state: Ledger, wide: bool, high_input: bool) -> unit ![Error<ConsoleError>] { expanded_ledger_mode(state, wide, high_input); }
    flow refused(self, error: string) -> i32 ![Error<ConsoleError>] { return simple_refused(error); }
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool, high_input: bool) -> i32 ![Error<ConsoleError>, Error<IndexError>] {
        display("FINAL ", answer);
        println(saved);
        expanded_ledger_mode(state, wide, high_input);
        return 0;
    }
}
