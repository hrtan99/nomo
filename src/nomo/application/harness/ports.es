module nomo.application.harness.ports;

import nomo.core.conversation.{Event, State};
import nomo.domain.harness.chat.Context as chat_Context;
import nomo.domain.harness.edit.Context as edit_Context;
import nomo.domain.harness.loop.{Action, Context as loop_Context, LoopTurn, Session, Shape};
import nomo.domain.harness.read.{Ledger as TextLedger, Observed, ReadContext, TextContext};
import nomo.domain.harness.work.Context as work_Context;
import nomo.domain.sessions.chain.ParentFacts;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.tools.workspace.ReadOnlyRoot;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, Region};
import std.io.IOError;

public effect LegacyChatStages {
    action main(context: chat_Context) -> string;
    action child(
        task: string,
        allowed: Array<string>,
        selected: State,
        multi: bool,
        resilient: bool,
        high_input: bool,
        reasoning: bool
    ) -> LoopTurn;
}

// Legacy strings and inspected child returns; never a native typed-output bridge.
public effect LegacyStringStages {
    action main(context: ReadContext) -> string;
    action child(task: string, allowed: Array<string>, selected: State) -> LoopTurn;
}

public effect LegacyChildModel {
    action infer(context: loop_Context) -> string;
}

public effect LegacyEditStages {
    action plan(context: work_Context) -> string;
    action child(context: work_Context) -> string;
    action aggregate(context: work_Context) -> string;
}

public effect ConversationOutput {
    action publish(event: Event) -> unit;
}

public effect DiagnosticOutput {
    action write(line: string) -> unit;
}

public effect HarnessProgress {
    action write(line: string) -> unit;
}

public effect ModelText {
    action infer(context: Context) -> string;
}

public spec ChildLoopPolicy {
    flow shape(self) -> Shape ![];
    flow allowed_error(self, allowed: Array<string>) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow request_error(self, request: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow validate_context(self, context: loop_Context) -> string ![Error<IndexError>];
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> ![Error<IndexError>];
    flow reserve_tool(self, state: Session) -> Result<Session, string> ![Error<IndexError>];
}

public spec ChildModel {
    flow infer(self, context: loop_Context) -> string ![Error<IndexError>];
}

public spec ReadStages {
    flow main(self, context: chat_Context) -> string ![];
    flow child(
        self,
        task: string,
        files: Array<string>,
        selected: State,
        multi: bool,
        resilient: bool,
        high_input: bool,
        reasoning: bool
    ) -> LoopTurn ![
        Fs.read<ReadOnlyRoot>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec ChatMainStage: callable chat_Context => string ![];

public spec ChatChildStage<R ~ Region>: callable (string, Array<string>, State) => LoopTurn ![
    Fs.read<R>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];

public spec WideChatChildStage<R ~ Region>: callable (string, Array<string>, State, bool, bool) => LoopTurn ![
    Fs.read<R>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];

public spec ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> ![
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow record(self, raw: string) -> string ![Error<IndexError>];
    flow diagnostic(self, raw: string, error: string, final_only: bool) -> string ![];
}

// Console is requested/default-handled by println; this bounds escaping errors.
public spec ConsoleEventSink: callable Event => unit ![Error<IOError>];

public spec ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<IOError>];
}

// Diagnostics are terminal observations, not conversation events or budget
// progress. Keeping a distinct sink prevents controllers from printing while
// preserving the legacy trace and incomplete-search messages exactly.
public spec DiagnosticSink {
    flow write(self, line: string) -> unit ![Error<IOError>];
}

// One complete progress line. The application retains order and accounting.
public spec ConsoleProgressWriter: callable string => unit ![Error<IOError>];

public spec ProgressSink {
    flow write(self, line: string) -> unit ![Error<IOError>];
}

public spec TextModelStage: callable Context => string ![];

public type Report = {
    request: string,
    task: string,
    allowed: Array<string>,
    child: Session,
    status: i32,
    observed: Observed,
    answer: string,
    ledger: Ledger
};

public type Failure = {
    state: Ledger,
    error: string,
    resolved: bool
};

public spec ReadContextValidation {
    flow request_error(self, value: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow validate_context(self, value: ReadContext) -> string ![Error<IndexError>];
    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>];
    flow rejection(self, raw: string, error: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<
        Observed,
        string
    > ![Error<IndexError>, Error<BudgetExceeded>];
    flow result_error(self, value: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow answer_error(self, value: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
}

public spec ReadContextBudget {
    flow reserve(self, value: Ledger, call: bool) -> Result<Ledger, string> ![];
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![];
    flow allowance(self) -> Ledger ![];
}

public spec ReadContextProgress {
    flow progress(self, phase: string, state: Ledger, prefix: string) -> Array<string> ![];
}

public spec WorkModelStages {
    flow read(self, context: ReadContext) -> string ![];
    flow read_child(self, task: string, files: Array<string>, selected: State) -> LoopTurn ![
        Fs.read<ReadOnlyRoot>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow plan(self, context: work_Context) -> string ![];
    flow propose(self, context: work_Context) -> string ![];
    flow summarize(self, context: work_Context) -> string ![];
}

// These are signatures of the existing interpreted stages; they do not grant
// File, model budget, parent authority or permission to replay prior work.
public spec ReadMainStage: callable ReadContext => string ![];

public spec EditTextStage: callable work_Context => string ![];

public spec StandaloneEditStage: callable edit_Context => string ![];

public spec ChainEditStage: callable (work_Context, Array<ParentFacts>) => string ![
    Error<IndexError>,
    Error<BudgetExceeded>
];

// Copied conversation data only. The caller owns the attempt and its budget.
public type Context = {
    history: Array<Event>,
    request: string
};

// The application owns charging and call order; assembly selects these interpreters.
public effect TextDelegationStages {
    action main(context: TextContext) -> string;
    action child(context: TextContext) -> string;
}

public effect TextDelegationOutput {
    action precharged(phase: string, state: TextLedger) -> unit;
    action settled(state: TextLedger) -> unit;
    action refused(state: TextLedger, error: string) -> i32;
    action line(text: string) -> unit;
}
