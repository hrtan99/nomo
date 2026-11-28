module nomo.domain.harness.read;

import nomo.domain.conversation.{TraceKind, TraceRole};
import nomo.domain.wire.{value as json_value, fields as json_fields};
import std.json.JsonValue;
import nomo.domain.harness.loop.{ReadOperation, tool_name};
import nomo.domain.harness.loop.{ReadAction};
import nomo.domain.conversation.TraceEvent;
import nomo.domain.harness.loop.{
    Action,
    ReadLedger,
    Session,
    allowed_error,
    candidate_error,
    decode_reply,
    read_plan_error,
    read_selection_error,
    response_error
};
import nomo.domain.limits.{
    child_answer_bytes,
    child_answer_frame_bytes,
    compatible_scan_bytes,
    compatible_scan_i32,
    context_bytes,
    history_bytes,
    legacy_scan_i32,
    message_bytes,
    message_frame_bytes,
    outcome_bytes,
    request_bytes,
    scan_bytes,
    scan_i32
};
import nomo.domain.text.{bounded as text_bounded, context_json_error, data_safe, text_printable};
import nomo.domain.wire.{FieldError, decode_fields, encode, string_fields};
import std.agent.message.Message;
import std.text.{char_count, from_char, from_i32, len, starts_with, trim};

public enum TextStage {
    Plan,
    Child,
    Aggregate
}

impl TextStage {
    public flow wire(self) -> string ![] {
        return match self {
            TextStage.Plan => "plan",
            TextStage.Child => "child",
            TextStage.Aggregate => "aggregate"
        };
    }

    public flow parse(raw: string) -> TextStage ![] {
        return match raw {
            "plan" => TextStage.Plan,
            "child" => TextStage.Child,
            "aggregate" => TextStage.Aggregate,
            _ => abort("invalid TextStage spelling: " + raw)
        };
    }
}

public enum ReadStage {
    Plan,
    Aggregate
}

impl ReadStage {
    public flow wire(self) -> string ![] {
        return match self {
            ReadStage.Plan => "plan",
            ReadStage.Aggregate => "aggregate"
        };
    }

    public flow parse(raw: string) -> ReadStage ![] {
        return match raw {
            "plan" => ReadStage.Plan,
            "aggregate" => ReadStage.Aggregate,
            _ => abort("invalid ReadStage spelling: " + raw)
        };
    }
}

public type ChildTask = {
    id: string,
    depth: i32,
    task: string,
    request: string
};

public type TextContext = {
    phase: TextStage,
    request: string,
    task: string,
    result: string
};

public type Ledger = {
    steps: i32,
    calls: i32,
    tokens: i32
};

public flow text_fresh() -> Ledger {
    return Ledger {
        steps = 0,
        calls = 0,
        tokens = 0
    };
}

public flow bounded(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= message_frame_bytes() && char_count(text) > 0
        && char_count(text) <= maximum && text_printable(text) && trim(text) != "";
}

// Both callers bound raw characters before this shared flat-frame scan.
// Only the current read plan permits standard JSON whitespace outside strings.
flow frame_error(raw: string, formatting: bool) -> string {
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    let slash = from_char('\\');
    @limits([Iterations(8388610)]) for codepoint in std.text.chars(raw) {
        let character = std.text.from_char(codepoint);
        let whitespace = character == " " || character == "\t" || character == "\r" || character == "\n";
        if !text_printable(character) && !(formatting && !quoted && whitespace) {
            return "control";
        }
        if quoted {
            if escaped {
                escaped = false;
            }
            else if character == slash {
                escaped = true;
            }
            else if character == "\"" {
                quoted = false;
            }
        } else if character == "" || character == " " || (formatting && whitespace) {
        } else if character == "[" {
            if opened || closed {
                return if formatting && !closed {
                    "shape"
                } else {
                    "frame"
                };
            }
            opened = true;
        } else if character == "]" {
            if !opened || closed {
                return "frame";
            }
            closed = true;
        } else if character == "\"" {
            if !opened || closed {
                return if formatting && !closed {
                    "shape"
                } else {
                    "frame"
                };
            }
            leaves = leaves + 1;
            if !formatting && leaves > 2 {
                return "frame";
            }
            quoted = true;
        } else if character != "," || !opened || closed {
            if formatting && !closed && (
                character == "{" || character == "-" || character == "t" || character == "f"
                    || character == "n" || character == "0" || character == "1" || character == "2"
                    || character == "3" || character == "4" || character == "5" || character == "6"
                    || character == "7" || character == "8" || character == "9"
            ) {
                return "shape";
            }
            return "frame";
        }
    }
    return if opened && closed && !quoted {
        ""
    } else {
        "frame"
    };
}

public type AsciiReadPlan = {
    compatible: bool
};

impl AsciiReadPlan {
    public flow decode(self, raw: string) -> Result<string, string> {
        if self.compatible {
            if char_count(raw) == 0 || char_count(raw) > message_frame_bytes() {
                return Err(read_plan_error(raw, "limit"));
            }
            let framed = frame_error(raw, true);
            if framed != "" {
                return Err(read_plan_error(raw, framed));
            }
        } else if !bounded(raw, message_frame_bytes()) || frame_error(raw, false) != "" {
            return Err("expected bounded flat single-line delegation JSON");
        }
        let fields = match decode_fields(raw) {
            Ok(value) => value,
            Err(FieldError.Json) => {
                return Err(
                    if self.compatible {
                        read_plan_error(raw, "json")
                    } else {
                        "invalid delegation JSON"
                    }
                );
            }
            Err(FieldError.Shape) => {
                return Err(
                    if self.compatible {
                        read_plan_error(raw, "shape")
                    } else {
                        "delegation fields must be strings"
                    }
                );
            }
        };
        if fields.len() != 2 {
            return Err(
                if self.compatible {
                    read_plan_error(raw, "arity")
                } else {
                    "unsupported delegation verb or arity"
                }
            );
        }
        if fields[0] != "delegate" {
            return Err(
                if self.compatible {
                    read_plan_error(raw, "verb")
                } else {
                    "unsupported delegation verb or arity"
                }
            );
        }
        if !bounded(fields[1], message_bytes()) {
            return Err(
                if self.compatible {
                    read_plan_error(raw, "task")
                } else {
                    "invalid bounded delegated task"
                }
            );
        }
        return Ok(fields[1]);
    }
}

public flow text_decode_plan(raw: string) -> Result<string, string> {
    let decoder = AsciiReadPlan {
        compatible = false
    };
    return decoder.decode(raw);
}

public flow decode_read_plan(raw: string) -> Result<string, string> {
    let decoder = AsciiReadPlan {
        compatible = true
    };
    return decoder.decode(raw);
}

public flow read_aggregate_error(raw: string) -> string {
    if char_count(raw) == 0 || char_count(raw) > message_bytes() {
        return response_error(raw, "read-aggregate", "limit", 512);
    }
    if !text_printable(raw) {
        return response_error(raw, "read-aggregate", "control", 512);
    }
    if trim(raw) == "" {
        return response_error(raw, "read-aggregate", "summary", 512);
    }
    return "";
}

// Check the complete Prompt.data encoding, not just its unescaped field values.
public flow text_context_error(context: TextContext) -> string {
    let message = Message.new(context.wire());
    return context_json_error(
        message.cast<JsonValue>(),
        context_bytes(),
        false,
        "model context exceeds 33554432 serialized characters"
    );
}

flow text_ledger_error(state: Ledger) -> string {
    if state.steps < 0 || state.steps > 5 || state.calls < 0 || state.calls > 3 || state.tokens < 0
        || state.tokens > 6144 {
        return "invalid shared model ledger";
    }
    // Range checks above precede multiplication/addition, preventing overflow.
    if state.calls > state.steps || state.steps > state.calls + 2 || state.tokens != state.calls * 2048 {
        return "invalid shared model ledger";
    }
    return "";
}

public flow charge_call(state: Ledger) -> Result<Ledger, string> {
    let invalid = text_ledger_error(state);
    if invalid != "" {
        return Err(invalid);
    }
    if state.steps >= 5 || state.calls >= 3 || state.tokens > 4096 {
        return Err("model call reservation exhausted");
    }
    return Ok(Ledger {
        steps = state.steps + 1,
        calls = state.calls + 1,
        tokens = state.tokens + 2048
    });
}

public flow charge_boundary(state: Ledger) -> Result<Ledger, string> {
    let invalid = text_ledger_error(state);
    if invalid != "" {
        return Err(invalid);
    }
    if state.steps >= 5 || state.steps >= state.calls + 2 {
        return Err("boundary reservation exhausted");
    }
    return Ok(state {
        steps = state.steps + 1
    });
}

public type ReadContext = {
    phase: ReadStage,
    request: string,
    task: string,
    result: string,
    tool: Option<ReadOperation>,
    outcome: string,
    allowed: Array<string>
};

public type Observed = {
    result: string,
    tool: Option<ReadOperation>,
    outcome: string
};

public flow numbers(state: ReadLedger) -> string {
    return "steps=" + from_i32(state.steps) + " calls=" + from_i32(state.calls) + " tokens="
        + from_i32(state.tokens) + " tools=" + from_i32(state.tools) + " scan=" + from_i32(state.scan);
}

public flow read_fresh() -> ReadLedger {
    return ReadLedger {
        steps = 0,
        calls = 0,
        tokens = 0,
        tools = 0,
        scan = 0
    };
}

public flow read_ledger_error(state: ReadLedger) -> string {
    if state.steps < 0 || state.steps > 7 || state.calls < 0 || state.calls > 4 || state.tokens < 0
        || state.tokens > 8192 || state.tools < 0 || state.tools > 1 || state.scan < 0 || state.scan > 16384 {
        return "invalid shared tool ledger";
    }
    if state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 2
        || state.tokens != state.calls * 2048 || (
        state.scan != state.tools * 4096
            && state.scan != state.tools * 16384
    ) {
        return "invalid shared tool ledger";
    }
    return "";
}

public flow bump(state: ReadLedger, call: bool) -> Result<
    ReadLedger,
    string
> {
    let invalid = read_ledger_error(state);
    if invalid != "" {
        return Err(invalid);
    }
    if state.steps >= 7 || (call && state.calls >= 4) || (
        !call && state.steps >= state.calls + state.tools
            + 2
    ) {
        return Err("shared reservation exhausted");
    }
    return Ok(
        state {
            steps = state.steps + 1,
            calls = state.calls + if call {
                1
            } else {
                0
            },
            tokens = state.tokens + if call {
                2048
            } else {
                0
            }
        }
    );
}

flow child_ledger_error(child: Session, work: bool) -> string {
    if child.history.spent < 1 || child.history.spent > 3 || child.calls < 1 || child.calls > 2
        || child.tokens > (if work {
        262144
    } else {
        4096
    }) || child.tools > 1 || child.scan > (if work {
        scan_bytes()
    } else {
        16384
    }) {
        return "invalid child ledger";
    }
    let calls: i32 = if child.calls == 2 {
        2
    } else {
        1
    };
    let tools: i32 = if child.tools == 1 {
        1
    } else {
        0
    };
    if child.history.spent != calls + tools || (child.tokens != child.calls * 2048 && !(
        work
            && (child.tokens == child.calls * 4096 || (child.calls == 2 && (
            child.tokens == 12288
                || child.tokens == 135168 || child.tokens == 262144
        )))
    )) || (
        child.scan != child.tools * 4096
            && child.scan != child.tools * 16384 && !(work && (
            child.scan == child.tools * 65540
                || (child.tools == 1 && compatible_scan_bytes(child.scan))
        ))
    ) || (
        child.calls == 2
            && child.tools != 1
    ) {
        return "invalid child ledger";
    }
    return "";
}

public flow settle(state: ReadLedger, child: Session) -> Result<
    ReadLedger,
    string
> {
    let invalid = read_ledger_error(state);
    if invalid != "" {
        return Err(invalid);
    }
    let child_invalid = child_ledger_error(child, false);
    if child_invalid != "" {
        return Err(child_invalid);
    }
    if state.steps != 2 || state.calls != 1 || state.tokens != 2048 || state.tools != 0 || state.scan != 0 {
        return Err("child reservation is not owned by this parent stage");
    }
    let calls: i32 = if child.calls == 2 {
        2
    } else {
        1
    };
    let tools: i32 = if child.tools == 1 {
        1
    } else {
        0
    };
    return Ok(
        ReadLedger {
            steps = 2 + child.history.spent,
            calls = 1 + calls,
            tokens = (1 + calls) * 2048,
            tools,
            scan = if child.scan == 16384 {
                16384
            } else {
                tools * 4096
            }
        }
    );
}

// Expanded work has one 2048-token parent plan, two 4096-token child
// attempts, and one 2048-token parent aggregate. Legacy ledgers remain valid.
public flow work_error(state: ReadLedger) -> string {
    if read_ledger_error(state) == "" {
        return "";
    }
    if state.steps >= 0 && state.steps <= 7 && state.calls >= 0 && state.calls <= 4
        && (state.tokens == state.calls * 4096 || (state.calls >= 3 && (
        state.tokens == state.calls * 4096
            + 4096 || state.tokens == state.calls * 4096 + 126976
    ))) && state.tools >= 0 && state.tools <= 1
        && (
        state.scan == state.tools * 4096 || state.scan == state.tools * 16384
            || state.scan == state.tools * 65540 || (state.tools == 1 && compatible_scan_i32(state.scan))
    )
        && state.steps >= state.calls + state.tools && state.steps <= state.calls + state.tools + 2 {
        return "";
    }
    if state.steps < 0 || state.steps > 7 || state.calls < 2 || state.calls > 4 || state.tools < 0
        || state.tools > 1 || (
        state.scan != state.tools * 4096 && state.scan != state.tools * 16384
            && state.scan != state.tools * 65540 && !(state.tools == 1 && compatible_scan_i32(state.scan))
    )
        || state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 2 {
        return "invalid expanded work read ledger";
    }
    let expected = if state.calls == 2 {
        6144
    } else {
        if state.calls == 3 {
            10240
        } else {
            12288
        }
    };
    return if state.tokens == expected {
        ""
    } else {
        "invalid expanded work read ledger"
    };
}

public flow wide_bump(state: ReadLedger, call: bool) -> Result<
    ReadLedger,
    string
> {
    let error = work_error(state);
    if error != "" || (state.tokens != state.calls * 4096 && !(
        state.calls >= 3
            && (state.tokens == state.calls * 4096 + 4096 || state.tokens == state.calls * 4096 + 126976)
    )) {
        return Err("invalid wide read ledger");
    }
    if state.steps >= 7 || (call && state.calls >= 4) || (
        !call && state.steps >= state.calls + state.tools
            + 2
    ) {
        return Err("shared reservation exhausted");
    }
    return Ok(
        state {
            steps = state.steps + 1,
            calls = state.calls + if call {
                1
            } else {
                0
            },
            tokens = state.tokens + if call {
                4096
            } else {
                0
            }
        }
    );
}

public flow work_bump(state: ReadLedger, call: bool) -> Result<
    ReadLedger,
    string
> {
    let error = work_error(state);
    if error != "" {
        return Err(error);
    }
    if state.calls < 3 {
        return bump(state, call);
    }
    if state.steps >= 7 || (call && state.calls != 3) || (
        !call && state.steps >= state.calls + state.tools
            + 2
    ) {
        return Err("shared reservation exhausted");
    }
    let next = state {
        steps = state.steps + 1,
        calls = state.calls + if call {
            1
        } else {
            0
        },
        tokens = state.tokens + if call {
            2048
        } else {
            0
        }
    };
    let invalid = work_error(next);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(next);
}

public flow high_input_error(state: ReadLedger) -> string {
    if state.steps < 0 || state.steps > 7 || state.calls < 0 || state.calls > 4
        || state.tokens != state.calls * 131072 || state.tools < 0 || state.tools > 1
        || (state.scan != state.tools * 65540 && !(state.tools == 1 && compatible_scan_i32(state.scan)))
        || state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 2 {
        return "invalid high-input work read ledger";
    }
    return "";
}

public flow high_input_bump(state: ReadLedger, call: bool) -> Result<
    ReadLedger,
    string
> {
    let error = high_input_error(state);
    if error != "" {
        return Err(error);
    }
    if state.steps >= 7 || (call && state.calls >= 4) || (
        !call && state.steps >= state.calls + state.tools
            + 2
    ) {
        return Err("shared reservation exhausted");
    }
    let next = state {
        steps = state.steps + 1,
        calls = state.calls + if call {
            1
        } else {
            0
        },
        tokens = state.tokens + if call {
            131072
        } else {
            0
        }
    };
    let invalid = high_input_error(next);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(next);
}

public flow high_input_settle(state: ReadLedger, child: Session) -> Result<
    ReadLedger,
    string
> {
    let expected = ReadLedger {
        steps = 2,
        calls = 1,
        tokens = 131072,
        tools = 0,
        scan = 0
    };
    if state != expected || child.history.spent != 3 || child.calls != 2 || child.tokens != 262144
        || child.tools != 1 || !compatible_scan_bytes(child.scan) {
        return Err("invalid high-input child ledger");
    }
    let value = ReadLedger {
        steps = 5,
        calls = 3,
        tokens = 393216,
        tools = 1,
        scan = scan_i32()
    };
    let error = high_input_error(value);
    if error != "" {
        return Err(error);
    }
    return Ok(value);
}

public flow work_settle(state: ReadLedger, child: Session) -> Result<
    ReadLedger,
    string
> {
    if child.tokens == child.calls * 2048 {
        return settle(state, child);
    }
    let expected = ReadLedger {
        steps = 2,
        calls = 1,
        tokens = if state.tokens == 4096 {
            4096
        } else {
            2048
        },
        tools = 0,
        scan = 0
    };
    if state != expected || child.calls < 1 || child.calls > 2 || (
        child.tokens != child.calls * 4096
            && !(state.tokens == 4096 && child.calls == 2 && (
            child.tokens == 12288
                || child.tokens == 135168
        ))
    )
        || child.tools > 1 || (
        child.scan != child.tools * 4096 && child.scan != child.tools * 16384
            && child.scan != child.tools * 65540 && !(child.tools == 1 && compatible_scan_bytes(child.scan))
    )
        || child.history.spent != (if child.calls == 2 {
        2
    } else {
        1
    }) + (if child.tools == 1 {
        1
    } else {
        0
    }) || (child.calls == 2 && child.tools != 1) {
        return Err("invalid expanded child ledger");
    }
    let calls = if child.calls == 2 {
        2
    } else {
        1
    };
    let tools = if child.tools == 1 {
        1
    } else {
        0
    };
    let value = ReadLedger {
        steps = 2 + child.history.spent,
        calls = 1 + calls,
        tokens = state.tokens + if child.tokens == 135168 {
            135168
        } else {
            if child.tokens == 12288 {
                12288
            } else {
                calls * 4096
            }
        },
        tools,
        scan = if compatible_scan_bytes(child.scan) {
            if child.scan == scan_bytes() {
                scan_i32()
            } else {
                legacy_scan_i32()
            }
        } else {
            if child.scan == 65540 {
                65540
            } else {
                if child.scan == 16384 {
                    16384
                } else {
                    tools * 4096
                }
            }
        }
    };
    let error = work_error(value);
    if error != "" {
        return Err(error);
    }
    return Ok(value);
}

public flow read_context_error(context: ReadContext) -> string {
    let message = Message.new(context.wire());
    return context_json_error(
        message.cast<JsonValue>(),
        context_bytes(),
        false,
        "model context exceeds 33554432 serialized characters"
    );
}

public flow same(event: TraceEvent, role: TraceRole, kind: TraceKind, name: string, text: string) -> bool {
    return event.role == role && event.kind == kind && event.name == name && event.text == text;
}

// Only the six ordinary return shapes reachable from our fresh seeded loop are admitted.
// Host aborts never reach this function and cannot be represented as settled returns.
public flow inspect_shared(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>,
    work: bool,
    unicode: bool
) -> Result<Observed, string> {
    let invalid = child_ledger_error(child, work);
    if invalid != "" {
        return Err(invalid);
    }
    if !(if unicode {
        text_bounded(request, message_bytes())
    } else {
        bounded(request, message_bytes())
    }) || !(if unicode {
        text_bounded(task, message_bytes())
    } else {
        bounded(task, message_bytes())
    }) || (if unicode {
        candidate_error(allowed)
    } else {
        allowed_error(allowed)
    }) != "" {
        return Err("invalid selected child context");
    }
    let events = child.history.events;
    let size = events.len();
    if size < 4 || size > 7 || child.history.stopped || child.history.characters > history_bytes() {
        return Err("invalid child history");
    }
    var characters: usize = 0;
    @limits([Iterations(7)]) for event in events {
        if char_count(event.name) > 8 || char_count(event.text) > outcome_bytes()
            || !text_printable(event.name) || !(
            if unicode {
                data_safe(event.text, outcome_bytes())
            } else {
                text_printable(event.text)
            }
        ) {
            return Err("invalid child event data");
        }
        characters = characters + char_count(event.name) + char_count(event.text);
    }
    if characters != child.history.characters
        || !same(events[0], TraceRole.User, TraceKind.Context, "original", request)
        || !same(events[1], TraceRole.User, TraceKind.Input, "", task)
        || !same(events[2], TraceRole.Model, TraceKind.Text, "qwen", "") {
        return Err("child original request or task history changed");
    }
    var tool: Option<ReadOperation> = None();
    var outcome = "";
    if child.tools == 0 {
        if size != 4 || child.calls != 1 || (status != 0 && status != 3) {
            return Err("invalid direct child shape");
        }
    } else {
        if size < 5 || events[3].role != TraceRole.Model || events[3].kind != TraceKind.Request {
            return Err("missing selected child tool request");
        }
        let action = match if unicode {
            decode_child(events[3].text, allowed, false)
        } else {
            decode_reply(events[3].text, allowed, false)
        }
        {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        let selected = match action {
            Action.Tool(value) => value,
            Action.Final(_) => {
                return Err("child tool identity changed");
            }
        };
        if events[3].name != selected.operation().wire()
            || events[4].role != TraceRole.Tool || events[4].name != selected.operation().wire() {
            return Err("child tool identity changed");
        }
        if size == 5 {
            if child.calls != 1 || status != 3 || events[4].kind != TraceKind.Error || !(
                if unicode {
                    text_bounded(events[4].text, message_bytes())
                } else {
                    bounded(events[4].text, message_bytes())
                }
            ) {
                return Err("invalid failed tool shape");
            }
        } else {
            if events[4].kind != TraceKind.Complete || !(
                if unicode {
                    text_bounded(events[4].text, outcome_bytes())
                } else {
                    bounded(events[4].text, 266)
                }
            ) || !starts_with(events[4].text, "complete: ") {
                return Err("invalid completed tool outcome");
            }
            if size == 6 {
                if child.calls != 1 || status != 4 {
                    return Err("invalid child context-refusal shape");
                }
            } else if child.calls != 2 || (status != 0 && status != 3)
                || !same(events[5], TraceRole.Model, TraceKind.Text, "qwen", "") {
                return Err("invalid second child call shape");
            }
            tool = Some(selected.operation());
            outcome = events[4].text;
        }
    }
    let last = events[size - 1];
    if status == 0 {
        if last.role != TraceRole.Assistant || last.kind != TraceKind.Final || last.name != ""
            || !(
            if unicode {
                text_bounded(last.text, child_answer_bytes())
            } else {
                bounded(last.text, message_bytes())
            }
        ) {
            return Err("invalid child final event");
        }
        return Ok(Observed {
            result = last.text,
            tool,
            outcome
        });
    }
    if size != 5 && (
        last.role != TraceRole.Error || last.kind != TraceKind.Error || last.name != "" || !(
            if unicode {
                text_bounded(last.text, message_bytes())
            } else {
                bounded(last.text, message_bytes())
            }
        )
    ) {
        return Err("invalid child refusal event");
    }
    return Ok(Observed {
        result = "",
        tool = None(),
        outcome = ""
    });
}

public flow read_inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<
    Observed,
    string
> {
    return inspect_shared(child, status, request, task, allowed, false, false);
}

public flow question_error(raw: string) -> string {
    return if text_bounded(raw, request_bytes()) {
        ""
    } else {
        "question requires 1..65536 safe UTF-8 bytes, not only spaces"
    };
}

// Decode the native flat string-array representation within its byte envelope.
flow fields(raw: string, maximum: usize) -> Result<Array<string>, string> {
    if raw == "" || len(raw) > maximum {
        return Err("expected bounded flat JSON string array");
    }
    return string_fields(raw, "invalid JSON", "expected string fields");
}

public flow compact_frame(raw: string) -> string {
    let values = match string_fields(raw, "invalid JSON", "expected string fields") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    return match encode(values, "action conversion refused", "action encoding refused") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

public flow unicode_read_decode_plan(raw: string) -> Result<string, string> {
    let values = match fields(raw, message_frame_bytes()) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if values.len() != 2 || values[0] != "delegate" || !text_bounded(values[1], message_bytes()) {
        return Err("invalid bounded delegated task");
    }
    return Ok(values[1]);
}

public flow decode_work_plan(raw: string) -> Result<string, string> {
    return unicode_read_decode_plan(raw);
}

public flow work_plan_rejection(raw: string) -> string {
    let values = match fields(raw, message_frame_bytes()) {
        Ok(item) => item,
        Err(_) => {
            return "unknown";
        }
    };
    if values.len() != 2 || values[0] != "delegate" {
        return "unknown";
    }
    if values[1] == "" || trim(values[1]) == "" {
        return "blank";
    }
    if char_count(values[1]) > message_bytes() || len(values[1]) > message_bytes() {
        return "length";
    }
    if !text_bounded(values[1], message_bytes()) {
        return "unsafe";
    }
    return "unknown";
}

public flow answer(raw: string) -> Result<string, string> {
    if !text_bounded(raw, message_bytes()) {
        return Err("invalid bounded final answer");
    }
    return Ok(raw);
}

// Report only the violated constraint; never display the model's rejected text.
flow child_final(text: string) -> Result<string, string> {
    if char_count(text) > child_answer_bytes() || len(text) > child_answer_bytes() {
        return Err("child final exceeds 1048576 UTF-8 bytes");
    }
    let line = text;
    if !text_bounded(line, child_answer_bytes()) {
        return Err("child final contains unsupported control or formatting characters or is empty");
    }
    return Ok(line);
}

public flow decode_child(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let invalid = candidate_error(allowed);
    if invalid != "" {
        return Err(invalid);
    }
    let values = match fields(raw, child_answer_frame_bytes()) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if values.len() < 2 || values.len() > 6 {
        return Err("invalid action field count");
    }
    if values[0] == "final" {
        if values.len() != 2 {
            return Err("child final must contain exactly two fields");
        }
        let final = match child_final(values[1]) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        return Ok(Action.Final(final));
    }
    if final_only {
        return Err("second response must be final");
    }
    // fields already checked structural whitespace and string safety above.
    if len(raw) > message_frame_bytes() {
        return Err("tool action exceeds 8388608 UTF-8 bytes");
    }
    if values[0] == "search" && values.len() == 3 && values[2] == "*" {
        let selected = read_selection_error(ReadOperation.Search, [allowed[0]], values[1], allowed);
        if selected != "" {
            return Err(selected);
        }
        return Ok(Action.Tool(ReadAction.Search(values[1], ["*"])));
    }
    var files: Array<string> = [];
    var literal = "";
    if values[0] == "read" && values.len() == 2 {
        files = [values[1]];
    }
    else if values[0] == "search" && values.len() >= 3 && values.len() <= 6 {
        literal = values[1];
        files = [values[2]];
        if values.len() >= 4 {
            files = files.push(values[3]);
        }
        if values.len() >= 5 {
            files = files.push(values[4]);
        }
        if values.len() >= 6 {
            files = files.push(values[5]);
        }
    } else {
        return Err("unsupported action or arity");
    }
    let selected = read_selection_error(ReadOperation.parse(values[0]), files, literal, allowed);
    if selected != "" {
        return Err(selected);
    }
    return Ok(
        Action.Tool(
            if values[0] == "read" {
                ReadAction.Read(files[0])
            } else {
                ReadAction.Search(literal, files)
            }
        )
    );
}

public flow read_validation_context_error(context: ReadContext) -> string {
    let message = Message.new(context.wire());
    return context_json_error(
        message.cast<JsonValue>(),
        context_bytes(),
        true,
        "model context exceeds 33554432 serialized characters"
    );
}

public flow read_validation_inspect(
    child: Session,
    status: i32,
    request: string,
    task: string,
    allowed: Array<string>
) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, false, true);
}

public flow inspect_work(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<
    Observed,
    string
> {
    return inspect_shared(child, status, request, task, allowed, true, true);
}

impl TextContext {
    public flow wire(self) -> JsonValue ![] {
        return json_fields(json_value(self), [("phase", JsonValue.String(self.phase.wire()))]);
    }
}
impl ReadContext {
    public flow wire(self) -> JsonValue ![] {
        return json_fields(
            json_value(self),
            [("phase", JsonValue.String(self.phase.wire())), ("tool", JsonValue.String(tool_name(self.tool)))]
        );
    }
}
