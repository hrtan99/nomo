module nomo.application.work_output;

import std.io.IOError as ConsoleError;
import nomo.harness.harness_work_contract.Ledger;
import nomo.tools.edit_contract.Selector;

// The reusable work controller owns ordering and state transitions. Terminal
// formatting is selected at the composition boundary.
public spec WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<ConsoleError>];
    flow diagnostic(self, line: string) -> unit ![Error<ConsoleError>];
    flow recorded(self, selected: Selector) -> unit ![Error<ConsoleError>, Error<IndexError>];
    flow ledger(self, state: Ledger, wide: bool) -> unit ![Error<ConsoleError>];
    flow refused(self, error: string) -> i32 ![Error<ConsoleError>];
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool) -> i32 ![Error<ConsoleError>, Error<IndexError>];
}
