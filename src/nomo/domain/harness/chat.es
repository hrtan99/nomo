module nomo.domain.harness.chat;

import nomo.domain.conversation.{Event, State, add, fresh};
import nomo.domain.harness.loop.{Context as loop_Context, ReadLedger, Session, allowed_error, candidate_error, context_error, question_error};
import nomo.domain.harness.read.{
    Observed,
    bounded as read_bounded,
    bump,
    decode_child,
    inspect_shared,
    question_error as read_question_error,
    read_fresh,
    read_ledger_error,
    settle
};
import nomo.domain.limits.{child_answer_bytes, context_bytes, message_bytes, outcome_bytes};
import nomo.domain.text.{bounded, context_json_error, data_safe, text_printable};
import std.agent.message.Message;
import std.json.JsonValue;
import std.text.{char_count, starts_with};

// Policies account configured reservations. They never dispatch a model or retry.
public spec ChatBudgetPolicy {
    flow maximum(self) -> ReadLedger ![];
    flow turn_limit(self) -> i32 ![];
    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow reserve_stage(self, value: ReadLedger, call: bool) -> Result<ReadLedger, string> ![];
    flow settle_child(self, value: ReadLedger, child: Session) -> Result<ReadLedger, string> ![];
    flow combine(self, previous: ReadLedger, local: ReadLedger) -> Result<ReadLedger, string> ![];
    flow pending(self, phase: string) -> ReadLedger ![];
    flow child_pending(self) -> ReadLedger ![];
    flow parent_tokens(self) -> i32 ![];
    flow child_action_tokens(self) -> i32 ![];
    flow child_final_tokens(self) -> i32 ![];
    flow resilient_child(self) -> bool ![];
    flow high_input_child(self) -> bool ![];
    flow reasoning_child(self) -> bool ![];
    flow unicode_protocol(self) -> bool ![];
    flow multiple_tools(self) -> bool ![];
}

public enum SingleMode {
    Legacy,
    Unicode,
    Extended,
    Persistent
}

public type SingleBudget = {
    mode: SingleMode
};

public type MultiBudget = {
    turns: i32,
    parent: i32,
    resilient: bool,
    reasoning: bool,
    ceiling: ReadLedger
};

public enum SelectedBudget {
    Single(SingleBudget),
    Multi(MultiBudget)
}

impl SingleBudget ~ ChatBudgetPolicy {
    flow maximum(self) -> ReadLedger ![] {
        return match self.mode {
            SingleMode.Extended => extended_maximum(),
            SingleMode.Persistent => session_maximum(),
            _ => default_maximum()
        };
    }

    flow turn_limit(self) -> i32 ![] {
        return match self.mode {
            SingleMode.Extended => 4,
            SingleMode.Persistent => 32,
            _ => 2
        };
    }

    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>, Error<BudgetExceeded>] {
        return match self.mode {
            SingleMode.Legacy => chat_turn_error(value),
            SingleMode.Unicode => chat_policy_turn_error(value),
            SingleMode.Extended => extended_turn_error(value),
            SingleMode.Persistent => session_turn_error(value)
        };
    }

    flow reserve_stage(self, value: ReadLedger, call: bool) -> Result<ReadLedger, string> ![] {
        return bump(value, call);
    }

    flow settle_child(self, value: ReadLedger, child: Session) -> Result<ReadLedger, string> ![] {
        return settle(value, child);
    }

    flow combine(self, previous: ReadLedger, local: ReadLedger) -> Result<ReadLedger, string> ![] {
        return match self.mode {
            SingleMode.Extended => extended_combine(previous, local),
            SingleMode.Persistent => session_combine(previous, local),
            _ => combine(previous, local, self.maximum())
        };
    }

    flow pending(self, phase: string) -> ReadLedger ![] {
        return pending(phase, false, 2048, 2048, 2048);
    }

    flow child_pending(self) -> ReadLedger ![] {
        return ReadLedger {
            steps = 3,
            calls = 2,
            tokens = 4096,
            tools = 1,
            scan = 16384
        };
    }

    flow parent_tokens(self) -> i32 ![] {
        return 2048;
    }

    flow child_action_tokens(self) -> i32 ![] {
        return 2048;
    }

    flow child_final_tokens(self) -> i32 ![] {
        return 2048;
    }

    flow resilient_child(self) -> bool ![] {
        return false;
    }

    flow high_input_child(self) -> bool ![] {
        return false;
    }

    flow reasoning_child(self) -> bool ![] {
        return false;
    }

    flow unicode_protocol(self) -> bool ![] {
        return self.mode != SingleMode.Legacy;
    }

    flow multiple_tools(self) -> bool ![] {
        return false;
    }
}

impl MultiBudget ~ ChatBudgetPolicy {
    flow maximum(self) -> ReadLedger ![] {
        return self.ceiling;
    }

    flow turn_limit(self) -> i32 ![] {
        return self.turns;
    }

    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>, Error<BudgetExceeded>] {
        return multi_turn_error(value, self.turns);
    }

    flow reserve_stage(self, value: ReadLedger, call: bool) -> Result<ReadLedger, string> ![] {
        return multi_bump(value, call, self.parent);
    }

    flow settle_child(self, value: ReadLedger, child: Session) -> Result<ReadLedger, string> ![] {
        return multi_settle(value, child, self.parent, self.resilient, self.reasoning);
    }

    flow combine(self, previous: ReadLedger, local: ReadLedger) -> Result<ReadLedger, string> ![] {
        return multi_combine(previous, local, self.ceiling);
    }

    flow pending(self, phase: string) -> ReadLedger ![] {
        return pending(phase, true, self.parent, self.child_action_tokens(), self.child_final_tokens());
    }

    flow child_pending(self) -> ReadLedger ![] {
        return ReadLedger {
            steps = 7,
            calls = 4,
            tokens = self.child_final_tokens() + self.child_action_tokens() * 3,
            tools = 3,
            scan = 12583680
        };
    }

    flow parent_tokens(self) -> i32 ![] {
        return self.parent;
    }

    flow child_action_tokens(self) -> i32 ![] {
        return if self.resilient && self.reasoning {
            131072
        } else {
            if self.reasoning {
                16384
            } else {
                4096
            }
        };
    }

    flow child_final_tokens(self) -> i32 ![] {
        return if self.resilient {
            131072
        } else {
            if self.reasoning {
                16384
            } else {
                4096
            }
        };
    }

    flow resilient_child(self) -> bool ![] {
        return self.resilient;
    }

    flow high_input_child(self) -> bool ![] {
        return self.parent == 8192 || (self.resilient && self.reasoning);
    }

    flow reasoning_child(self) -> bool ![] {
        return self.reasoning;
    }

    flow unicode_protocol(self) -> bool ![] {
        return true;
    }

    flow multiple_tools(self) -> bool ![] {
        return true;
    }
}

flow pending(phase: string, multi: bool, parent: i32, child_action: i32, child_final: i32) -> ReadLedger {
    let calls = if phase == "aggregate" {
        0
    } else {
        if multi {
            5
        } else {
            3
        }
    };
    let tools = if phase == "aggregate" {
        0
    } else {
        if multi {
            3
        } else {
            1
        }
    };
    let steps = if phase == "plan" {
        if multi {
            10
        } else {
            6
        }
    } else {
        if phase == "child" {
            if multi {
                9
            } else {
                5
            }
        } else {
            0
        }
    };
    return ReadLedger {
        steps,
        calls,
        tokens = if calls == 0 {
            0
        } else {
            if multi {
                parent + child_final + child_action * 3
            } else {
                6144
            }
        },
        tools,
        scan = tools * if multi {
            4194560
        } else {
            16384
        }
    };
}

// This is the sole compatibility mapping from saved maxima to runtime policy.
public flow select(value: Invocation, unicode: bool) -> SelectedBudget {
    if unicode {
        if value.maximum == multi_full_maximum(48) {
            return SelectedBudget.Multi(
                MultiBudget {
                    turns = 48,
                    parent = 131072,
                    resilient = true,
                    reasoning = true,
                    ceiling = value.maximum
                }
            );
        }
        if value.maximum == multi_input_reasoning_maximum(48) {
            return SelectedBudget.Multi(
                MultiBudget {
                    turns = 48,
                    parent = 8192,
                    resilient = false,
                    reasoning = true,
                    ceiling = value.maximum
                }
            );
        }
        if value.maximum == multi_input_maximum(48) {
            return SelectedBudget.Multi(
                MultiBudget {
                    turns = 48,
                    parent = 8192,
                    resilient = false,
                    reasoning = false,
                    ceiling = value.maximum
                }
            );
        }
        if value.maximum == multi_resilient_maximum(48) {
            return SelectedBudget.Multi(
                MultiBudget {
                    turns = 48,
                    parent = 131072,
                    resilient = true,
                    reasoning = false,
                    ceiling = value.maximum
                }
            );
        }
        if value.maximum == multi_large_maximum(48) {
            return SelectedBudget.Multi(
                MultiBudget {
                    turns = 48,
                    parent = 131072,
                    resilient = false,
                    reasoning = false,
                    ceiling = value.maximum
                }
            );
        }
        @limits([Iterations(3)]) for turns in [2, 32, 48] {
            if value.maximum == multi_wide_maximum(turns) {
                return SelectedBudget.Multi(
                    MultiBudget {
                        turns,
                        parent = 4096,
                        resilient = false,
                        reasoning = false,
                        ceiling = value.maximum
                    }
                );
            }
            if turns != 48 && value.maximum == multi_maximum(turns) {
                return SelectedBudget.Multi(
                    MultiBudget {
                        turns,
                        parent = 2048,
                        resilient = false,
                        reasoning = false,
                        ceiling = value.maximum
                    }
                );
            }
        }
        if value.maximum == session_maximum() {
            return SelectedBudget.Single(SingleBudget {
                mode = SingleMode.Persistent
            });
        }
        if value.maximum == extended_maximum() {
            return SelectedBudget.Single(SingleBudget {
                mode = SingleMode.Extended
            });
        }
    }
    return SelectedBudget.Single(SingleBudget {
        mode = if unicode {
            SingleMode.Unicode
        } else {
            SingleMode.Legacy
        }
    });
}

public type Context = {
    phase: string,
    request: string,
    task: string,
    result: string,
    tool: string,
    outcome: string,
    allowed: Array<string>,
    prior: Previous
};

public type Completed = {
    request: string,
    task: string,
    result: string,
    tool: string,
    outcome: string,
    answer: string,
    records: Array<Event>
};

public type LocalTurn = {
    status: i32,
    usage: ReadLedger,
    selected: Previous,
    resolved: bool,
    completed: Option<Completed>
};

public type TurnResult = {
    status: i32,
    state: Invocation,
    resolved: bool,
    completed: Option<Completed>
};

public flow default_maximum() -> ReadLedger {
    return ReadLedger {
        steps = 14,
        calls = 8,
        tokens = 16384,
        tools = 2,
        scan = 32768
    };
}

public flow fresh_invocation() -> Invocation {
    return Invocation {
        usage = read_fresh(),
        maximum = default_maximum(),
        admitted = 0,
        prior = empty()
    };
}

public flow empty() -> Previous {
    return Previous {
        task = "",
        result = "",
        tool = "",
        outcome = "",
        answer = ""
    };
}

public flow prior_error_mode(prior: Previous, unicode: bool) -> string {
    if prior.task == "" {
        if prior.result != "" || prior.tool != "" || prior.outcome != "" || prior.answer != "" {
            return "invalid empty prior selection";
        }
        return "";
    }
    let invalid = if unicode {
        !bounded(prior.task, message_bytes()) || !bounded(prior.result, child_answer_bytes())
            || !bounded(prior.answer, message_bytes())
    }
    else {
        question_error(prior.task) != "" || !read_bounded(prior.result, message_bytes())
            || !read_bounded(prior.answer, message_bytes())
    };
    if invalid {
        return "invalid selected prior result";
    }
    if prior.tool == "" {
        if prior.outcome != "" {
            return "prior outcome without tool";
        }
    } else if (prior.tool != "read" && prior.tool != "search") || !(
        if unicode {
            bounded(prior.outcome, outcome_bytes())
        } else {
            read_bounded(prior.outcome, 266)
        }
    ) || !(
        starts_with(prior.outcome, "complete: ") || (
            unicode && prior.tool == "search" && starts_with(prior.outcome, "incomplete: ")
        )
    ) {
        return "invalid selected prior tool";
    }
    return "";
}

public flow chat_prior_error(prior: Previous) -> string {
    return prior_error_mode(prior, false);
}

public flow chat_context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(
        message.cast<JsonValue>(),
        context_bytes(),
        false,
        "model context exceeds 33554432 serialized characters"
    );
}

public flow seed(request: string, prior: Previous) -> State {
    var state = add(fresh(), Event {
        role = "user",
        kind = "context",
        name = "original",
        text = request
    });
    if prior.task != "" {
        state = add(state, Event {
            role = "user",
            kind = "context",
            name = "task",
            text = prior.task
        });
        state = add(state, Event {
            role = "user",
            kind = "context",
            name = "result",
            text = prior.result
        });
        state = add(state, Event {
            role = "user",
            kind = "context",
            name = "tool",
            text = prior.tool
        });
        state = add(state, Event {
            role = "user",
            kind = "context",
            name = "outcome",
            text = prior.outcome
        });
        state = add(state, Event {
            role = "user",
            kind = "context",
            name = "answer",
            text = prior.answer
        });
    }
    return state;
}

public flow same(left: Event, right: Event) -> bool {
    return left.role == right.role && left.kind == right.kind && left.name == right.name
        && left.text == right.text;
}

// Check every prior event before projecting the unchanged one-shot validator's
// canonical local history. Projection is validation only; model inputs retain it.
public flow inspect_turn_shared(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>,
    prior: Previous,
    unicode: bool
) -> Result<Observed, string> {
    let paths = if unicode {
        candidate_error(allowed)
    } else {
        allowed_error(allowed)
    };
    if paths != "" {
        return Err(paths);
    }
    let expected = seed(request, prior);
    let size = expected.events.len();
    if child.history.events.len() < size + 2 || child.history.events.len() > size + 6 || child.history.stopped {
        return Err("invalid selected prior history");
    }
    var position: usize = 0;
    var normalized = fresh();
    var input = fresh();
    var characters: usize = 0;
    @limits([Iterations(12)]) for event in child.history.events {
        if char_count(event.name) > 8 || char_count(event.text) > outcome_bytes()
            || !text_printable(event.name) || !(
            if unicode {
                data_safe(event.text, outcome_bytes())
            } else {
                text_printable(event.text)
            }
        ) {
            return Err("invalid selected history data");
        }
        characters = characters + char_count(event.name) + char_count(event.text);
        if position < size && !same(event, expected.events[position]) {
            return Err("selected prior history changed");
        }
        if position == 0 || position >= size {
            normalized = add(normalized, event);
        }
        if position < size + 1 {
            input = add(input, event);
        }
        position = position + 1;
    }
    if characters != child.history.characters {
        return Err("invalid selected history character count");
    }
    if child.calls == 0 {
        let events = normalized.events;
        let expected_input = Event {
            role = "user",
            kind = "input",
            name = "",
            text = task
        };
        if events.len() != 3 || status != 4 || child.history.spent != 0 || child.tokens != 0
            || child.tools != 0 || child.scan != 0 || !same(events[1], expected_input)
            || events[2].role != "error" || events[2].kind != "error" || events[2].name != ""
            || events[2].text != (if unicode {
            "model context exceeds 33554432 serialized characters"
        } else {
            "model context exceeds 33554432 serialized characters"
        }) {
            return Err("invalid unattempted child context refusal");
        }
        let context = loop_Context {
            history = input.events,
            allowed,
            final_only = false
        };
        if (if unicode {
            read_question_error(request)
        } else {
            question_error(request)
        }) != "" || !(if unicode {
            bounded(task, message_bytes())
        } else {
            question_error(task) == ""
        }) || context_error(context) != events[2].text {
            return Err("unproven child context refusal");
        }
        return Ok(Observed {
            result = "",
            tool = "",
            outcome = ""
        });
    }
    let state = child.history {
        events = normalized.events,
        characters = normalized.characters
    };
    return inspect_shared(child {
        history = state
    }, status, request, task, allowed, unicode, unicode);
}

public flow chat_inspect_turn(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>,
    prior: Previous
) -> Result<Observed, string> {
    let invalid = chat_prior_error(prior);
    if invalid != "" {
        return Err(invalid);
    }
    return inspect_turn_shared(child, status, request, task, allowed, prior, false);
}

public flow invocation_error(state: ReadLedger) -> string {
    if state.steps < 0 || state.steps > 14 || state.calls < 0 || state.calls > 8 || state.tokens < 0
        || state.tokens > 16384 || state.tools < 0 || state.tools > 2 || state.scan < 0 || state.scan > 32768 {
        return "invalid invocation ledger";
    }
    if state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 4
        || state.tokens != state.calls * 2048 || (
        state.scan < state.tools * 4096
            || state.scan > state.tools * 16384 || state.scan % 4096 != 0
    ) {
        return "invalid invocation ledger";
    }
    return "";
}

public flow admission_error(state: ReadLedger, maximum: ReadLedger) -> string {
    let invalid = invocation_error(state);
    if invalid != "" {
        return invalid;
    }
    if maximum.steps < 0 || maximum.steps > 14 || maximum.calls < 0 || maximum.calls > 8 || maximum.tokens < 0
        || maximum.tokens > 16384 || maximum.tools < 0 || maximum.tools > 2 || maximum.scan < 0
        || maximum.scan > 32768 {
        return "invalid invocation limits";
    }
    if state.steps > maximum.steps - 7 || state.calls > maximum.calls - 4
        || state.tokens > maximum.tokens - 8192 || state.tools > maximum.tools - 1
        || state.scan > maximum.scan - 16384 {
        return "invocation worst-case turn reservation exhausted";
    }
    return "";
}

public flow turn_error_shared(invocation: Invocation, selected: string) -> string {
    let invalid = admission_error(invocation.usage, invocation.maximum);
    if invalid != "" {
        return invalid;
    }
    if selected != "" {
        return selected;
    }
    let used = invocation.usage;
    if invocation.admitted == 0 {
        if invocation.prior.task != "" || used.steps != 0 || used.calls != 0 || used.tokens != 0
            || used.tools != 0 || used.scan != 0 {
            return "first turn must own an empty invocation";
        }
    } else if invocation.admitted == 1 {
        let tools = if invocation.prior.tool == "" {
            0
        } else {
            1
        };
        if invocation.prior.task == "" || used.steps != 5 + tools * 2 || used.calls != 3 + tools
            || used.tokens != (3 + tools) * 2048 || used.tools != tools || (
            used.scan != tools * 4096
                && used.scan != tools * 16384
        ) {
            return "prior selection and invocation ledger disagree";
        }
    } else {
        return "turn limit reached";
    }
    return "";
}

public flow chat_turn_error(invocation: Invocation) -> string {
    return turn_error_shared(invocation, chat_prior_error(invocation.prior));
}

public flow combine(state: ReadLedger, usage: ReadLedger, maximum: ReadLedger) -> Result<ReadLedger, string> {
    let invalid = admission_error(state, maximum);
    if invalid != "" {
        return Err(invalid);
    }
    let used = read_ledger_error(usage);
    if used != "" {
        return Err(used);
    }
    let result = ReadLedger {
        steps = state.steps + usage.steps,
        calls = state.calls + usage.calls,
        tokens = state.tokens + usage.tokens,
        tools = state.tools + usage.tools,
        scan = state.scan + usage.scan
    };
    let error = invocation_error(result);
    if error != "" {
        return Err(error);
    }
    return Ok(result);
}

public flow chat_policy_prior_error(prior: Previous) -> string {
    return prior_error_mode(prior, true);
}

public flow chat_policy_context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(
        message.cast<JsonValue>(),
        33554432,
        true,
        "model context exceeds 33554432 serialized bytes"
    );
}

// Check every prior event before projecting the unchanged one-shot validator's
// canonical local history. Projection is validation only; model inputs retain it.
public flow chat_policy_inspect_turn(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>,
    prior: Previous
) -> Result<Observed, string> {
    let invalid = chat_policy_prior_error(prior);
    if invalid != "" {
        return Err(invalid);
    }
    return inspect_turn_shared(child, status, request, task, allowed, prior, true);
}

public flow chat_policy_turn_error(invocation: Invocation) -> string {
    return turn_error_shared(invocation, chat_policy_prior_error(invocation.prior));
}

// The opt-in four-turn budget is separate from the legacy two-turn contract.
// Amounts are reservations in application accounting, not measured usage.
public flow extended_maximum() -> ReadLedger {
    return ReadLedger {
        steps = 28,
        calls = 16,
        tokens = 32768,
        tools = 4,
        scan = 65536
    };
}

public flow extended_invocation() -> Invocation {
    return Invocation {
        usage = read_fresh(),
        maximum = extended_maximum(),
        admitted = 0,
        prior = empty()
    };
}

public flow is_extended(maximum: ReadLedger) -> bool {
    return maximum == extended_maximum();
}

flow extended_ledger_error(value: ReadLedger) -> string {
    if value.steps < 0 || value.steps > 28 || value.calls < 0 || value.calls > 16 || value.tokens < 0
        || value.tokens > 32768 || value.tools < 0 || value.tools > 4 || value.scan < 0 || value.scan > 65536 {
        return "invalid extended invocation ledger";
    }
    if value.steps < value.calls + value.tools || value.steps > value.calls + value.tools + 8
        || value.tokens != value.calls * 2048 || (
        value.scan < value.tools * 4096
            || value.scan > value.tools * 16384 || value.scan % 4096 != 0
    ) {
        return "invalid extended invocation ledger";
    }
    return "";
}

public flow extended_admission_error(value: ReadLedger) -> string {
    let invalid = extended_ledger_error(value);
    if invalid != "" {
        return invalid;
    }
    if value.steps > 21 || value.calls > 12 || value.tokens > 24576 || value.tools > 3 || value.scan > 49152 {
        return "invocation worst-case turn reservation exhausted";
    }
    return "";
}

public flow extended_turn_error(invocation: Invocation) -> string {
    if !is_extended(invocation.maximum) {
        return "invalid extended invocation limits";
    }
    let capacity = extended_admission_error(invocation.usage);
    if capacity != "" {
        return capacity;
    }
    let invalid = chat_policy_prior_error(invocation.prior);
    if invalid != "" {
        return invalid;
    }
    let turns = invocation.admitted;
    let used = invocation.usage;
    if turns < 0 || turns > 3 {
        return "turn limit reached";
    }
    if turns == 0 {
        if invocation.prior.task != "" || used.steps != 0 || used.calls != 0 || used.tokens != 0
            || used.tools != 0 || used.scan != 0 {
            return "first turn must own an empty invocation";
        }
    } else {
        let last_tool = if invocation.prior.tool == "" {
            0
        } else {
            1
        };
        if invocation.prior.task == "" || used.tools < last_tool || used.tools - last_tool > turns - 1
            || used.steps != turns * 5 + used.tools * 2 || used.calls != turns * 3 + used.tools
            || used.tokens != used.calls * 2048 || (
            used.scan < used.tools * 4096
                || used.scan > used.tools * 16384 || used.scan % 4096 != 0
        ) {
            return "prior selection and invocation ledger disagree";
        }
    }
    return "";
}

public flow extended_combine(previous: ReadLedger, local: ReadLedger) -> Result<ReadLedger, string> {
    let invalid = extended_admission_error(previous);
    if invalid != "" {
        return Err(invalid);
    }
    let bad_local = read_ledger_error(local);
    if bad_local != "" {
        return Err(bad_local);
    }
    let value = ReadLedger {
        steps = previous.steps + local.steps,
        calls = previous.calls + local.calls,
        tokens = previous.tokens + local.tokens,
        tools = previous.tools + local.tools,
        scan = previous.scan + local.scan
    };
    let bad_total = extended_ledger_error(value);
    if bad_total != "" {
        return Err(bad_total);
    }
    return Ok(value);
}

// Persistent event sessions reserve a bounded series of turns without
// resetting any already charged usage.
public flow session_maximum() -> ReadLedger {
    return ReadLedger {
        steps = 224,
        calls = 128,
        tokens = 262144,
        tools = 32,
        scan = 524288
    };
}

public flow session_invocation() -> Invocation {
    return Invocation {
        usage = read_fresh(),
        maximum = session_maximum(),
        admitted = 0,
        prior = empty()
    };
}

public flow session_turn_error(value: Invocation) -> string {
    if value.maximum != session_maximum() || value.admitted < 0 || value.admitted > 31 {
        return "session turn limit reached";
    }
    let used = value.usage;
    let turns = value.admitted;
    if used.tools < 0 || used.tools > turns || used.steps != turns * 5 + used.tools * 2
        || used.calls != turns * 3 + used.tools || used.tokens != used.calls * 2048
        || (used.scan < used.tools * 4096 || used.scan > used.tools * 16384 || used.scan % 4096 != 0) {
        return "invalid session ledger";
    }
    let problem = chat_policy_prior_error(value.prior);
    if problem != "" {
        return problem;
    }
    if (turns == 0 && value.prior.task != "") || (turns > 0 && value.prior.task == "") {
        return "invalid session prior";
    }
    let last_tool = if value.prior.tool == "" {
        0
    } else {
        1
    };
    if turns > 0 && (used.tools < last_tool || used.tools - last_tool > turns - 1) {
        return "invalid session prior tool";
    }
    return "";
}

public flow session_combine(previous: ReadLedger, local: ReadLedger) -> Result<ReadLedger, string> {
    let error = read_ledger_error(local);
    if error != "" {
        return Err(error);
    }
    let value = ReadLedger {
        steps = previous.steps + local.steps,
        calls = previous.calls + local.calls,
        tokens = previous.tokens + local.tokens,
        tools = previous.tools + local.tools,
        scan = previous.scan + local.scan
    };
    if value.steps > 224 || value.calls > 128 || value.tokens > 262144 || value.tools > 32
        || value.scan > 524288 {
        return Err("session allowance exhausted");
    }
    return Ok(value);
}

// Check every seed and completed tool action before admitting a multi-step result.
public flow inspect_multi_turn(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>,
    prior: Previous,
    resilient: bool,
    reasoning: bool
) -> Result<Observed, string> {
    if chat_policy_prior_error(prior) != "" || candidate_error(allowed) != ""
        || !bounded(request, message_bytes()) || !bounded(task, message_bytes()) {
        return Err("invalid child context");
    }
    let tool_failure = status == 3 && child.tools > 0 && child.calls == child.tools;
    let action_tokens = if resilient && reasoning {
        131072
    } else {
        if reasoning {
            16384
        } else {
            4096
        }
    };
    let final_tokens = if resilient {
        131072
    } else {
        action_tokens
    };
    let child_final = child.tokens - child.tools * action_tokens;
    if (status != 0 && status != 3) || child.history.stopped || child.tools > 3 || (
        !tool_failure
            && child.calls != child.tools + 1
    ) || (
        child.calls == child.tools
            && child.tokens != child.tools * action_tokens
    ) || (
        child.calls != child.tools
            && child_final != final_tokens && !(final_tokens == 131072 && child_final == 4096)
    )
        || child.scan != child.tools * 4194560 {
        return Err("invalid multi-step child ledger");
    }
    let steps: i32 = if child.tools == 3 {
        7
    } else {
        if child.tools == 2 {
            5
        } else {
            if child.tools == 1 {
                3
            } else {
                1
            }
        }
    };
    if child.history.spent != steps - if tool_failure {
        1
    } else {
        0
    }
    {
        return Err("invalid multi-step child steps");
    }
    let expected = seed(request, prior);
    let start = expected.events.len();
    let events = child.history.events;
    if events.len() != start + 1 + child.tools * 3 + if tool_failure {
        0
    } else {
        2
    }
    {
        return Err("invalid multi-step event count");
    }
    var index: usize = 0;
    var characters: usize = 0;
    @limits([Iterations(18)]) for event in events {
        if char_count(event.name) > 8 || char_count(event.text) > outcome_bytes()
            || !text_printable(event.name) || !data_safe(event.text, outcome_bytes()) {
            return Err("invalid multi-step event");
        }
        if index < start && !same(event, expected.events[index]) {
            return Err("selected prior history changed");
        }
        characters = characters + char_count(event.name) + char_count(event.text);
        index = index + 1;
    }
    if characters != child.history.characters || !same(
        events[start],
        Event {
            role = "user",
            kind = "input",
            name = "",
            text = task
        }
    ) {
        return Err("invalid multi-step history");
    }
    var cursor = start + 1;
    var tool = "";
    var outcome = "";
    var i: usize = 0;
    @limits([Iterations(3)]) while i < child.tools {
        if !same(events[cursor], Event {
            role = "model",
            kind = "text",
            name = "qwen",
            text = ""
        }) {
            return Err("invalid multi-step model event");
        }
        let request_event = events[cursor + 1];
        let action = match decode_child(request_event.text, allowed, false) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        let result = events[cursor + 2];
        if tool_failure && i + 1 == child.tools {
            if request_event.role != "model" || request_event.kind != "request"
                || request_event.name != action.operation || (
                action.operation != "read"
                    && action.operation != "search"
            ) || result.role != "tool" || result.kind != "error"
                || result.name != action.operation || !bounded(result.text, outcome_bytes()) {
                return Err("invalid failed tool outcome");
            }
            return Ok(Observed {
                result = "",
                tool = "",
                outcome = ""
            });
        }
        if request_event.role != "model" || request_event.kind != "request"
            || request_event.name != action.operation || (
            action.operation != "read"
                && action.operation != "search"
        ) || result.role != "tool" || result.kind != "complete"
            || result.name != action.operation || !(
            starts_with(result.text, "complete: ") || (
                action.operation == "search" && starts_with(result.text, "incomplete: ")
            )
        ) {
            return Err("invalid multi-step tool outcome");
        }
        tool = action.operation;
        outcome = result.text;
        cursor = cursor + 3;
        i = i + 1;
    }
    if !same(events[cursor], Event {
        role = "model",
        kind = "text",
        name = "qwen",
        text = ""
    }) {
        return Err("invalid final model event");
    }
    let final = events[cursor + 1];
    if status == 3 {
        if final.role != "error" || final.kind != "error" || final.name != ""
            || !bounded(final.text, message_bytes()) {
            return Err("invalid multi-step refusal");
        }
        return Ok(Observed {
            result = "",
            tool = "",
            outcome = ""
        });
    }
    if final.role != "assistant" || final.kind != "final" || final.name != ""
        || !bounded(final.text, child_answer_bytes()) {
        return Err("invalid multi-step final");
    }
    return Ok(Observed {
        result = final.text,
        tool,
        outcome
    });
}

// Separate reservations preserve the meaning of existing session records.
public flow multi_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 20480,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

// A new reservation covers two 4096-token parent calls; legacy records retain their allowance.
public flow multi_wide_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 24576,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

// New main stages reserve 131072 output tokens each; child calls stay separate.
public flow multi_large_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 278528,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

// Format 16 keeps three 4096-token child actions but gives its final child
// response the same 131072-token reasoning-safe cap as each parent stage.
public flow multi_resilient_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 405504,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

// Explicit high-input sessions keep the large parent context but reserve only
// 8192 tokens for each parent and 4096 for each child model call. This leaves
// substantially more of a provider context window available to saved history.
public flow multi_input_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 32768,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

// Format 18 preserves the high-input context while giving every child model
// stage enough generation space for reasoning before its bounded protocol reply.
public flow multi_input_reasoning_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 81920,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

public flow multi_full_maximum(turns: i32) -> ReadLedger {
    return ReadLedger {
        steps = turns * 11,
        calls = turns * 6,
        tokens = turns * 786432,
        tools = turns * 3,
        scan = turns * 12583680
    };
}

public flow multi_error(value: ReadLedger) -> string {
    if value.steps < 0 || value.steps > 11 || value.calls < 0 || value.calls > 6 || value.tools < 0
        || value.tools > 3 || (
        value.tokens < value.calls * 2048 || value.tokens > value.calls * 131072
            || value.tokens % 2048 != 0
    ) || value.scan != value.tools * 4194560 || value.steps < value.calls
        + value.tools || value.steps > value.calls + value.tools + 2 {
        return "invalid multi-step ledger";
    }
    return "";
}

public flow multi_bump(value: ReadLedger, call: bool, parent: i32) -> Result<ReadLedger, string> {
    if multi_error(value) != "" {
        return Err("invalid multi-step ledger");
    }
    let next = value {
        steps = value.steps + 1,
        calls = value.calls + if call {
            1
        } else {
            0
        },
        tokens = value.tokens + if call {
            parent
        } else {
            0
        }
    };
    let error = multi_error(next);
    if error != "" {
        return Err(error);
    }
    return Ok(next);
}

public flow multi_settle(value: ReadLedger, child: Session, parent: i32, resilient: bool, reasoning: bool) -> Result<
    ReadLedger,
    string
> {
    let expected = ReadLedger {
        steps = 2,
        calls = 1,
        tokens = parent,
        tools = 0,
        scan = 0
    };
    if value != expected {
        return Err("child reservation not owned");
    }
    let action_tokens = if resilient && reasoning {
        131072
    } else {
        if reasoning {
            16384
        } else {
            4096
        }
    };
    let final_tokens = if resilient {
        131072
    } else {
        action_tokens
    };
    let expected_tokens = child.tools * action_tokens + if child.calls == child.tools {
        0
    } else {
        final_tokens
    };
    let early_tokens = child.tools * action_tokens + if child.calls == child.tools {
        0
    } else {
        4096
    };
    if child.tools > 3 || (child.calls != child.tools && child.calls != child.tools + 1) || child.calls == 0
        || (child.tokens != expected_tokens && !(final_tokens == 131072 && child.tokens == early_tokens))
        || child.scan != child.tools * 4194560 {
        return Err("invalid multi-step child ledger");
    }
    let tools: i32 = if child.tools == 3 {
        3
    } else {
        if child.tools == 2 {
            2
        } else {
            if child.tools == 1 {
                1
            } else {
                0
            }
        }
    };
    let calls = tools + if child.calls == child.tools {
        0
    } else {
        1
    };
    if child.history.spent != calls + tools {
        return Err("invalid multi-step child steps");
    }
    let generation = tools * if resilient && reasoning {
        131072
    } else {
        if reasoning {
            16384
        } else {
            4096
        }
    } + if child.calls == child.tools {
        0
    } else {
        if resilient && child.tokens == early_tokens {
            4096
        } else {
            if resilient {
                131072
            } else {
                if reasoning {
                    16384
                } else {
                    4096
                }
            }
        }
    };
    return Ok(
        ReadLedger {
            steps = 2 + calls + tools,
            calls = 1 + calls,
            tokens = parent + generation,
            tools,
            scan = tools * 4194560
        }
    );
}

public flow multi_turn_error(value: Invocation, maximum: i32) -> string {
    if value.maximum == multi_full_maximum(maximum) {
        let used = value.usage;
        let turns = value.admitted;
        if turns < 0 || turns > maximum || used.tools < 0 || used.tools > turns * 3 || used.steps != turns * 5
            + used.tools * 2 || used.calls != turns * 3 + used.tools || used.tokens != used.calls * 131072
            || used.scan != used.tools * 4194560 || chat_policy_prior_error(value.prior) != "" || (
            turns == 0
                && value.prior.task != ""
        ) || (turns > 0 && value.prior.task == "") {
            return "invalid full-output session ledger";
        }
        return "";
    }
    let legacy = ReadLedger {
        steps = maximum * 11,
        calls = maximum * 6,
        tokens = maximum * 12288,
        tools = maximum * 3,
        scan = maximum * 49152
    };
    let previous = ReadLedger {
        steps = maximum * 11,
        calls = maximum * 6,
        tokens = maximum * 12288,
        tools = maximum * 3,
        scan = maximum * 12583680
    };
    if (
        value.maximum != multi_input_reasoning_maximum(maximum)
            && value.maximum != multi_input_maximum(maximum)
            && value.maximum != multi_resilient_maximum(maximum)
            && value.maximum != multi_large_maximum(maximum) && value.maximum != multi_wide_maximum(maximum)
            && value.maximum != multi_maximum(maximum) && value.maximum != legacy
            && value.maximum != previous
    )
        || value.admitted < 0 || value.admitted > maximum {
        return "multi-step session turn limit reached";
    }
    let used = value.usage;
    let turns = value.admitted;
    let scan_step = if value.maximum == legacy {
        4096
    } else {
        256
    };
    if used.tools < 0 || used.tools > turns * 3 || used.steps != turns * 5 + used.tools * 2
        || used.calls != turns * 3 + used.tools || used.tokens < used.calls * 2048
        || used.tokens > turns * (if value.maximum == multi_resilient_maximum(maximum) {
        393216
    } else {
        if value.maximum == multi_large_maximum(maximum) {
            266240
        } else {
            if value.maximum == multi_input_reasoning_maximum(maximum) {
                32768
            } else {
                if value.maximum == multi_input_maximum(maximum) {
                    20480
                } else {
                    if value.maximum == multi_wide_maximum(maximum) {
                        12288
                    } else {
                        8192
                    }
                }
            }
        }
    }) + used.tools * if value.maximum == multi_input_reasoning_maximum(maximum) {
        16384
    } else {
        4096
    } || used.tokens % 2048 != 0 || (
        value.maximum == multi_resilient_maximum(maximum)
            && (
            used.tokens < turns * 266240 + used.tools * 4096 || used.tokens > turns * 393216
                + used.tools * 4096 || (used.tokens - turns * 266240 - used.tools * 4096) % 126976 != 0
        )
    )
        || (
        value.maximum == multi_large_maximum(maximum) && used.tokens != turns * 266240
            + used.tools * 4096
    ) || (
        value.maximum == multi_input_reasoning_maximum(maximum)
            && used.tokens != turns * 32768 + used.tools * 16384
    )
        || (value.maximum == multi_input_maximum(maximum) && used.tokens != turns * 20480 + used.tools * 4096)
        || (value.maximum == multi_wide_maximum(maximum) && used.tokens != turns * 12288 + used.tools * 4096)
        || (
        value.maximum != multi_maximum(maximum) && value.maximum != multi_wide_maximum(maximum)
            && value.maximum != multi_input_maximum(maximum)
            && value.maximum != multi_input_reasoning_maximum(maximum)
            && value.maximum != multi_large_maximum(maximum)
            && value.maximum != multi_resilient_maximum(maximum)
            && used.tokens != used.calls * 2048
    ) || used.scan < used.tools * 4096
        || used.scan > used.tools * if value.maximum == legacy {
        16384
    } else {
        4194560
    } || used.scan % scan_step != 0 {
        return "invalid multi-step session ledger";
    }
    if chat_policy_prior_error(value.prior) != "" || (turns == 0 && value.prior.task != "") || (
        turns > 0
            && value.prior.task == ""
    ) {
        return "invalid multi-step prior";
    }
    let last_tool = if value.prior.tool == "" {
        0
    } else {
        1
    };
    let prior_limit = (turns - 1) * 3 + if last_tool == 1 {
        2
    } else {
        0
    };
    if turns > 0 && (used.tools < last_tool || used.tools - last_tool > prior_limit) {
        return "invalid multi-step prior tool";
    }
    return "";
}

public flow multi_combine(previous: ReadLedger, local: ReadLedger, maximum: ReadLedger) -> Result<
    ReadLedger,
    string
> {
    let error = multi_error(local);
    if error != "" {
        return Err(error);
    }
    let value = ReadLedger {
        steps = previous.steps + local.steps,
        calls = previous.calls + local.calls,
        tokens = previous.tokens + local.tokens,
        tools = previous.tools + local.tools,
        scan = previous.scan + local.scan
    };
    if value.steps > maximum.steps || value.calls > maximum.calls || value.tokens > maximum.tokens
        || value.tools > maximum.tools || value.scan > maximum.scan {
        return Err("multi-step session allowance exhausted");
    }
    return Ok(value);
}

// Only validated successful selected data crosses a turn boundary.
public type Previous = {
    task: string,
    result: string,
    tool: string,
    outcome: string,
    answer: string
};

public type Invocation = {
    usage: ReadLedger,
    maximum: ReadLedger,
    admitted: i32,
    prior: Previous
};
