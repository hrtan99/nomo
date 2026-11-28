module nomo.domain.sessions.checkpoints;

import nomo.domain.conversation.{Event, State};
import nomo.domain.harness.chat.{
    Context,
    Invocation,
    Previous,
    TurnResult,
    chat_context_error,
    chat_inspect_turn,
    chat_prior_error,
    chat_turn_error
};
import nomo.domain.harness.loop.{Context as loop_Context, ReadLedger, Session, allowed_error, context_error};
import nomo.domain.harness.read.{bounded, read_inspect, same, text_decode_plan};
import nomo.domain.limits.{context_bytes, history_bytes, message_bytes, message_frame_bytes};
import nomo.domain.text.text_printable;
import nomo.domain.wire.{encode, string_fields};
import std.text.{char_count, from_char, from_i32, from_usize, is_ascii, len, parse_i32, trim};

public type Checkpoint = {
    format: i32,
    identity: Identity,
    request: string,
    task: string,
    result: string,
    tool: string,
    outcome: string,
    answer: string,
    records: Array<Event>,
    usage: ReadLedger,
    maximum: ReadLedger,
    admitted: i32,
    lifecycle: string,
    resolved: bool
};

public flow identity_error(identity: Identity) -> string {
    if !bounded(identity.id, 128) || !bounded(identity.workspace, 128) {
        return "invalid checkpoint identity";
    }
    if identity.allowed.len() > 2 {
        return "legacy checkpoint supports at most two allowed files";
    }
    return allowed_error(identity.allowed);
}

// This is a completed first boundary, not admission to another turn.
public flow checkpoint_validate(saved: Checkpoint, requested: Identity) -> Result<Checkpoint, string> {
    let identity = identity_error(saved.identity);
    if identity != "" {
        return Err(identity);
    }
    let expected = identity_error(requested);
    if expected != "" {
        return Err(expected);
    }
    if saved.identity != requested {
        return Err("checkpoint identity or workspace binding mismatch");
    }
    if saved.format != 1 || saved.admitted != 1 || saved.lifecycle != "completed" || !saved.resolved {
        return Err("checkpoint is not a completed settled first turn");
    }
    if !bounded(saved.request, message_bytes()) || !bounded(saved.task, message_bytes()) {
        return Err("invalid checkpoint request or task");
    }
    let prior = Previous {
        task = saved.task,
        result = saved.result,
        tool = saved.tool,
        outcome = saved.outcome,
        answer = saved.answer
    };
    let invalid_prior = chat_prior_error(prior);
    if invalid_prior != "" {
        return Err(invalid_prior);
    }
    var tools: i32 = 0;
    var child_count: usize = 4;
    var record_count: usize = 9;
    if saved.tool != "" {
        tools = 1;
        child_count = 7;
        record_count = 13;
    }
    let exact = ReadLedger {
        steps = 5 + tools * 2,
        calls = 3 + tools,
        tokens = (3 + tools) * 2048,
        tools,
        scan = tools * 4096
    };
    if saved.usage != exact {
        return Err("checkpoint completed usage mismatch");
    }
    let maximum = saved.maximum;
    let original_maximum = ReadLedger {
        steps = 14,
        calls = 8,
        tokens = 16384,
        tools = 2,
        scan = 8192
    };
    if maximum != original_maximum {
        return Err("invalid checkpoint invocation limits");
    }
    if exact.steps > maximum.steps || exact.calls > maximum.calls || exact.tokens > maximum.tokens
        || exact.tools > maximum.tools || exact.scan > maximum.scan {
        return Err("checkpoint usage exceeds saved limits");
    }
    let records = saved.records;
    if records.len() != record_count {
        return Err("invalid checkpoint record count");
    }
    let record_error = records_error(records, history_bytes(), "checkpoint");
    if record_error != "" {
        return Err(record_error);
    }
    if !same(records[0], "user", "request", "", saved.request)
        || !same(records[1], "main", "plan", "", records[1].text)
        || !same(records[2], "main", "delegate", "child-1", saved.task) {
        return Err("invalid checkpoint planning records");
    }
    let task = match text_decode_plan(records[1].text) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if task != saved.task {
        return Err("checkpoint plan and delegated task disagree");
    }
    var events: Array<Event> = [];
    var child_characters: usize = 0;
    var index: usize = 0;
    @limits([Iterations(7)]) while index < child_count {
        let event = records[3 + index];
        events = events.push(event);
        child_characters = child_characters + char_count(event.name) + char_count(event.text);
        index = index + 1;
    }
    let child_tools: usize = if tools == 1 {
        1
    } else {
        0
    };
    let child_calls: usize = if tools == 1 {
        2
    } else {
        1
    };
    let child = Session {
        history = State {
            events,
            characters = child_characters,
            spent = 1
                + tools * 2,
            stopped = false
        },
        calls = child_calls,
        tokens = child_calls * 2048,
        tools = child_tools,
        scan = child_tools * 4096
    };
    let observed = match read_inspect(child, 0, saved.request, saved.task, saved.identity.allowed) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if observed.result != saved.result || observed.tool != saved.tool || observed.outcome != saved.outcome {
        return Err("checkpoint child records and selected result disagree");
    }
    let consumed = 3 + child_count;
    if !same(records[consumed], "main", "consume", "child-1", saved.result)
        || !same(records[record_count - 1], "main", "answer", "", saved.answer) {
        return Err("invalid checkpoint consumption records");
    }
    if tools == 1 && !same(records[consumed + 1], "main", "tool", saved.tool, saved.outcome) {
        return Err("checkpoint completed tool record mismatch");
    }
    return Ok(saved);
}

public flow checkpoint_from_turn(identity: Identity, turn: TurnResult) -> Result<Checkpoint, string> {
    if turn.status != 0 || !turn.resolved || turn.state.admitted != 1 {
        return Err("only a successful resolved first turn can be saved");
    }
    let completed = match turn.completed {
        Some(value) => value,
        None() => {
            return Err("completed application records missing");
        }
    };
    let prior = Previous {
        task = completed.task,
        result = completed.result,
        tool = completed.tool,
        outcome = completed.outcome,
        answer = completed.answer
    };
    if turn.state.prior != prior {
        return Err("completed result and selected prior disagree");
    }
    let saved = Checkpoint {
        format = 1,
        identity,
        request = completed.request,
        task = completed.task,
        result = completed.result,
        tool = completed.tool,
        outcome = completed.outcome,
        answer = completed.answer,
        records = completed.records,
        usage = turn.state.usage,
        maximum = turn.state.maximum,
        admitted = 1,
        lifecycle = "completed",
        resolved = true
    };
    return checkpoint_validate(saved, identity);
}

// Reject nested shapes and bound encoded bytes before JSON parsing/casting.
public flow framed(raw: string, successor: bool) -> bool {
    let limit: usize = context_bytes();
    if char_count(raw) == 0 || char_count(raw) > limit || len(raw) > limit {
        return false;
    }
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    var characters: usize = 0;
    var field_size: usize = 0;
    var unicode: usize = 0;
    let slash = from_char('\\');
    @limits([Iterations(33554434)]) for codepoint in std.text.chars(raw) {
        let character = std.text.from_char(codepoint);
        if character != "" && !is_ascii(character) {
            return false;
        }
        if quoted {
            if unicode > 0 {
                unicode = unicode - 1;
            }
            else if escaped {
                escaped = false;
                if character == "u" {
                    unicode = 4;
                }
            }
            else if character == slash {
                escaped = true;
                field_size = field_size + 1;
                characters = characters + 1;
            }
            else if character == "\"" {
                quoted = false;
            }
            else {
                field_size = field_size + 1;
                characters = characters + 1;
            }
            let maximum: usize = message_frame_bytes();
            if field_size > maximum || characters > (context_bytes()) {
                return false;
            }
        } else if character == "" || character == " " || character == "\n" || character == "\r"
            || character == "\t" {
        } else if character == "[" {
            if opened || closed {
                return false;
            }
            opened = true;
        } else if character == "]" {
            if !opened || closed {
                return false;
            }
            closed = true;
        } else if character == "\"" {
            if !opened || closed {
                return false;
            }
            leaves = leaves + 1;
            if leaves > (if successor {
                100
            } else {
                80
            }) {
                return false;
            }
            quoted = true;
            field_size = 0;
        } else if character != "," || !opened || closed {
            return false;
        }
    }
    return opened && closed && !quoted && !escaped && unicode == 0;
}

flow number(raw: string, maximum: i32, label: string) -> Result<i32, string> {
    if char_count(raw) == 0 || char_count(raw) > 5 {
        return Err("invalid canonical " + label + " number");
    }
    let value = match parse_i32(raw) {
        Ok(item) => item,
        Err(_) => {
            return Err("invalid canonical " + label + " number");
        }
    };
    if value < 0 || from_i32(value) != raw {
        return Err("invalid canonical " + label + " number");
    }
    if value > maximum {
        return Err(label + " number exceeds bound");
    }
    return Ok(value);
}

public flow read_ledger(fields: Array<string>, offset: usize, label: string) -> Result<ReadLedger, string> {
    let limits: Array<i32> = [14, 8, 16384, 2, 8192];
    var values: Array<i32> = [];
    var index: usize = 0;
    @limits([Iterations(5)]) while index < 5 {
        let value = match number(fields[offset + index], limits[index], label) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        values = values.push(value);
        index = index + 1;
    }
    return Ok(
        ReadLedger {
            steps = values[0],
            calls = values[1],
            tokens = values[2],
            tools = values[3],
            scan = values[4]
        }
    );
}

public flow records_error(records: Array<Event>, maximum: usize, label: string) -> string {
    var characters: usize = 0;
    @limits([Iterations(18)]) for event in records {
        if char_count(event.role) > 9 || char_count(event.kind) > 8 || char_count(event.name) > 8
            || char_count(event.text) > message_bytes() || !text_printable(event.role)
            || !text_printable(event.kind) || !text_printable(event.name) || !text_printable(event.text) {
            return "invalid " + label + " record data";
        }
        characters = characters + char_count(event.name) + char_count(event.text);
        if characters > maximum {
            return label + " record content exceeds bound";
        }
    }
    return "";
}

public flow fields_error(fields: Array<string>, successor: bool) -> string {
    let error = (if successor {
        "successor"
    } else {
        "checkpoint"
    }) + " string fields exceed bounds";
    if fields.len() > (if successor {
        100
    } else {
        80
    }) {
        return error;
    }
    var characters: usize = 0;
    var index: usize = 0;
    @limits([Iterations(100)]) for field in fields {
        if char_count(field) > (message_frame_bytes()) {
            return error;
        }
        characters = characters + char_count(field);
        index = index + 1;
        if characters > (context_bytes()) {
            return error;
        }
    }
    return "";
}

public flow checkpoint_encode(saved: Checkpoint) -> Result<string, string> {
    match checkpoint_validate(saved, saved.identity) {
        Err(error) => {
            return Err(error);
        }
        Ok(_) => (),
    }
    var second = "";
    if saved.identity.allowed.len() == 2 {
        second = saved.identity.allowed[1];
    }
    var fields = [
        "nomo-harness-checkpoint-v1",
        saved.identity.id,
        saved.identity.workspace,
        saved.identity.allowed[0],
        second,
        saved.request,
        saved.task,
        saved.result,
        saved.tool,
        saved.outcome,
        saved.answer,
        from_i32(saved.usage.steps),
        from_i32(saved.usage.calls),
        from_i32(saved.usage.tokens),
        from_i32(saved.usage.tools),
        from_i32(saved.usage.scan),
        from_i32(saved.maximum.steps),
        from_i32(saved.maximum.calls),
        from_i32(saved.maximum.tokens),
        from_i32(saved.maximum.tools),
        from_i32(saved.maximum.scan),
        "1",
        "completed",
        "true",
        from_usize(saved.records.len())
    ];
    @limits([Iterations(13)]) for event in saved.records {
        fields = fields.push(event.role);
        fields = fields.push(event.kind);
        fields = fields.push(event.name);
        fields = fields.push(event.text);
    }
    let invalid_fields = fields_error(fields, false);
    if invalid_fields != "" {
        return Err(invalid_fields);
    }
    let encoded = match encode(
        fields,
        "checkpoint encoding conversion refused",
        "checkpoint JSON encoding refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !framed(encoded, false) {
        return Err("checkpoint encoded bounds exceeded");
    }
    return Ok(encoded);
}

public flow checkpoint_decode(raw: string) -> Result<Checkpoint, string> {
    if !framed(raw, false) {
        return Err("checkpoint encoded shape or bounds invalid");
    }
    let fields = match string_fields(raw, "invalid checkpoint JSON", "checkpoint fields must be strings") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let invalid_fields = fields_error(fields, false);
    if invalid_fields != "" {
        return Err(invalid_fields);
    }
    if fields.len() != 61 && fields.len() != 77 {
        return Err("invalid checkpoint field count");
    }
    if fields[0] != "nomo-harness-checkpoint-v1" {
        return Err("unsupported checkpoint format");
    }
    if fields[21] != "1" || fields[22] != "completed" || fields[23] != "true" {
        return Err("checkpoint is not completed and settled");
    }
    var record_count: usize = 9;
    if fields.len() == 77 {
        record_count = 13;
    }
    if fields[24] != from_usize(record_count) {
        return Err("checkpoint record count disagrees with framing");
    }
    var allowed = [fields[3]];
    if fields[4] != "" {
        allowed = allowed.push(fields[4]);
    }
    let identity = Identity {
        id = fields[1],
        workspace = fields[2],
        allowed
    };
    let usage = match read_ledger(fields, 11, "checkpoint") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let maximum = match read_ledger(fields, 16, "checkpoint") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    var records: Array<Event> = [];
    var index: usize = 0;
    @limits([Iterations(13)]) while index < record_count {
        let offset = 25 + index * 4;
        records = records.push(
            Event {
                role = fields[offset],
                kind = fields[offset + 1],
                name = fields[offset + 2],
                text = fields[offset + 3]
            }
        );
        index = index + 1;
    }
    let saved = Checkpoint {
        format = 1,
        identity,
        request = fields[5],
        task = fields[6],
        result = fields[7],
        tool = fields[8],
        outcome = fields[9],
        answer = fields[10],
        records,
        usage,
        maximum,
        admitted = 1,
        lifecycle = "completed",
        resolved = true
    };
    return checkpoint_validate(saved, identity);
}

// Independent second-boundary format. The original v1 first boundary stays intact.
public type Successor = {
    format: i32,
    identity: Identity,
    predecessor: Checkpoint,
    predecessor_version: string,
    request: string,
    task: string,
    result: string,
    tool: string,
    outcome: string,
    answer: string,
    records: Array<Event>,
    usage: ReadLedger,
    maximum: ReadLedger,
    admitted: i32,
    lifecycle: string,
    resolved: bool
};

flow previous(saved: Checkpoint) -> Previous {
    return Previous {
        task = saved.task,
        result = saved.result,
        tool = saved.tool,
        outcome = saved.outcome,
        answer = saved.answer
    };
}

public flow restore(saved: Checkpoint) -> Result<Invocation, string> {
    match checkpoint_validate(saved, saved.identity) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let invocation = Invocation {
        usage = saved.usage,
        maximum = saved.maximum,
        admitted = saved.admitted,
        prior = previous(saved)
    };
    let invalid = chat_turn_error(invocation);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(invocation);
}

public flow successor_validate(saved: Successor, requested: Identity, predecessor_identity: Identity) -> Result<
    Successor,
    string
> {
    let invalid = identity_error(requested);
    if invalid != "" {
        return Err(invalid);
    }
    if saved.identity != requested || saved.identity.id == predecessor_identity.id
        || saved.identity.workspace != predecessor_identity.workspace
        || saved.identity.allowed != predecessor_identity.allowed {
        return Err("successor identity or predecessor binding mismatch");
    }
    match checkpoint_validate(saved.predecessor, predecessor_identity) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let restored = match restore(saved.predecessor) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if char_count(saved.predecessor_version) == 0 || char_count(saved.predecessor_version) > 1024
        || !text_printable(saved.predecessor_version) || trim(saved.predecessor_version) == "" {
        return Err("invalid predecessor version");
    }
    if saved.format != 1 || saved.admitted != 2 || saved.lifecycle != "completed" || !saved.resolved {
        return Err("successor is not a completed settled second turn");
    }
    if !bounded(saved.request, message_bytes()) || !bounded(saved.task, message_bytes()) {
        return Err("invalid successor request or task");
    }
    let selected = Previous {
        task = saved.task,
        result = saved.result,
        tool = saved.tool,
        outcome = saved.outcome,
        answer = saved.answer
    };
    let invalid_prior = chat_prior_error(selected);
    if invalid_prior != "" {
        return Err(invalid_prior);
    }
    var tools: i32 = 0;
    var child_count: usize = 9;
    var record_count: usize = 14;
    if saved.tool != "" {
        tools = 1;
        child_count = 12;
        record_count = 18;
    }
    let before = restored.usage;
    let exact = ReadLedger {
        steps = before.steps + 5 + tools * 2,
        calls = before.calls + 3 + tools,
        tokens = before.tokens + (3 + tools) * 2048,
        tools = before.tools + tools,
        scan = before.scan + tools * 4096
    };
    if saved.usage != exact || saved.maximum != restored.maximum {
        return Err("successor cumulative usage or limits mismatch");
    }
    let records = saved.records;
    if records.len() != record_count {
        return Err("invalid successor record count");
    }
    let record_error = records_error(records, history_bytes(), "successor");
    if record_error != "" {
        return Err(record_error);
    }
    if !same(records[0], "user", "request", "", saved.request)
        || !same(records[1], "main", "plan", "", records[1].text)
        || !same(records[2], "main", "delegate", "child-1", saved.task) {
        return Err("invalid successor planning records");
    }
    let task = match text_decode_plan(records[1].text) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if task != saved.task {
        return Err("successor plan and delegated task disagree");
    }
    var events: Array<Event> = [];
    var child_characters: usize = 0;
    var index: usize = 0;
    var first_input: Array<Event> = [];
    var final_input: Array<Event> = [];
    @limits([Iterations(12)]) while index < child_count {
        let event = records[3 + index];
        events = events.push(event);
        if index < 7 {
            first_input = first_input.push(event);
        }
        if index < 10 {
            final_input = final_input.push(event);
        }
        child_characters = child_characters + char_count(event.name) + char_count(event.text);
        index = index + 1;
    }
    let child_tools: usize = if tools == 1 {
        1
    } else {
        0
    };
    let child_calls: usize = if tools == 1 {
        2
    } else {
        1
    };
    let child = Session {
        history = State {
            events,
            characters = child_characters,
            spent = 1
                + tools * 2,
            stopped = false
        },
        calls = child_calls,
        tokens = child_calls * 2048,
        tools = child_tools,
        scan = child_tools * 4096
    };
    let observed = match chat_inspect_turn(
        child,
        0,
        saved.request,
        saved.task,
        saved.identity.allowed,
        restored.prior
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if observed.result != saved.result || observed.tool != saved.tool || observed.outcome != saved.outcome {
        return Err("successor child records and selected result disagree");
    }
    let consumed = 3 + child_count;
    if !same(records[consumed], "main", "consume", "child-1", saved.result)
        || !same(records[record_count - 1], "main", "answer", "", saved.answer) {
        return Err("invalid successor consumption records");
    }
    if tools == 1 && !same(records[consumed + 1], "main", "tool", saved.tool, saved.outcome) {
        return Err("successor completed tool record mismatch");
    }
    let plan = Context {
        phase = "plan",
        request = saved.request,
        task = "",
        result = "",
        tool = "",
        outcome = "",
        allowed = saved.identity.allowed,
        prior = restored.prior
    };
    let aggregate = Context {
        phase = "aggregate",
        request = saved.request,
        task = saved.task,
        result = saved.result,
        tool = saved.tool,
        outcome = saved.outcome,
        allowed = saved.identity.allowed,
        prior = restored.prior
    };
    let first = loop_Context {
        history = first_input,
        allowed = saved.identity.allowed,
        final_only = false
    };
    let final = loop_Context {
        history = final_input,
        allowed = saved.identity.allowed,
        final_only = true
    };
    let plan_error = chat_context_error(plan);
    if plan_error != "" {
        return Err(plan_error);
    }
    let aggregate_error = chat_context_error(aggregate);
    if aggregate_error != "" {
        return Err(aggregate_error);
    }
    let first_error = context_error(first);
    if first_error != "" {
        return Err(first_error);
    }
    if tools == 1 {
        let final_error = context_error(final);
        if final_error != "" {
            return Err(final_error);
        }
    }
    return Ok(saved);
}

public flow successor_from_turn(
    identity: Identity,
    predecessor: Checkpoint,
    predecessor_version: string,
    turn: TurnResult
) -> Result<Successor, string> {
    if turn.status != 0 || !turn.resolved || turn.state.admitted != 2 {
        return Err("only a successful resolved second turn can be saved");
    }
    let completed = match turn.completed {
        Some(value) => value,
        None() => {
            return Err("completed successor records missing");
        }
    };
    let selected = Previous {
        task = completed.task,
        result = completed.result,
        tool = completed.tool,
        outcome = completed.outcome,
        answer = completed.answer
    };
    if turn.state.prior != selected {
        return Err("completed successor and selected prior disagree");
    }
    let saved = Successor {
        format = 1,
        identity,
        predecessor,
        predecessor_version,
        request = completed.request,
        task = completed.task,
        result = completed.result,
        tool = completed.tool,
        outcome = completed.outcome,
        answer = completed.answer,
        records = completed.records,
        usage = turn.state.usage,
        maximum = turn.state.maximum,
        admitted = 2,
        lifecycle = "completed",
        resolved = true
    };
    return successor_validate(saved, identity, predecessor.identity);
}

public flow successor_encode(saved: Successor) -> Result<string, string> {
    match successor_validate(saved, saved.identity, saved.predecessor.identity) {
        Err(error) => {
            return Err(error);
        }
        Ok(_) => (),
    }
    let predecessor = match checkpoint_encode(saved.predecessor) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    var second = "";
    if saved.identity.allowed.len() == 2 {
        second = saved.identity.allowed[1];
    }
    var fields = [
        "nomo-harness-successor-v1",
        saved.identity.id,
        saved.identity.workspace,
        saved.identity.allowed[0],
        second,
        predecessor,
        saved.predecessor_version,
        saved.request,
        saved.task,
        saved.result,
        saved.tool,
        saved.outcome,
        saved.answer,
        from_i32(saved.usage.steps),
        from_i32(saved.usage.calls),
        from_i32(saved.usage.tokens),
        from_i32(saved.usage.tools),
        from_i32(saved.usage.scan),
        from_i32(saved.maximum.steps),
        from_i32(saved.maximum.calls),
        from_i32(saved.maximum.tokens),
        from_i32(saved.maximum.tools),
        from_i32(saved.maximum.scan),
        "2",
        "completed",
        "true",
        from_usize(saved.records.len())
    ];
    @limits([Iterations(18)]) for event in saved.records {
        fields = fields.push(event.role);
        fields = fields.push(event.kind);
        fields = fields.push(event.name);
        fields = fields.push(event.text);
    }
    let invalid = fields_error(fields, true);
    if invalid != "" {
        return Err(invalid);
    }
    let encoded = match encode(
        fields,
        "successor encoding conversion refused",
        "successor JSON encoding refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !framed(encoded, true) {
        return Err("successor encoded bounds exceeded");
    }
    return Ok(encoded);
}

public flow successor_decode(raw: string) -> Result<Successor, string> {
    if !framed(raw, true) {
        return Err("successor encoded shape or bounds invalid");
    }
    let fields = match string_fields(raw, "invalid successor JSON", "successor fields must be strings") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let invalid = fields_error(fields, true);
    if invalid != "" {
        return Err(invalid);
    }
    if fields.len() != 83 && fields.len() != 99 {
        return Err("invalid successor field count");
    }
    if fields[0] != "nomo-harness-successor-v1" {
        return Err("unsupported successor format");
    }
    if fields[23] != "2" || fields[24] != "completed" || fields[25] != "true" {
        return Err("successor is not completed and settled");
    }
    var record_count: usize = 14;
    if fields.len() == 99 {
        record_count = 18;
    }
    if fields[26] != from_usize(record_count) {
        return Err("successor record count disagrees with framing");
    }
    var allowed = [fields[3]];
    if fields[4] != "" {
        allowed = allowed.push(fields[4]);
    }
    let identity = Identity {
        id = fields[1],
        workspace = fields[2],
        allowed
    };
    let predecessor = match checkpoint_decode(fields[5]) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let usage = match read_ledger(fields, 13, "successor") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let maximum = match read_ledger(fields, 18, "successor") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    var records: Array<Event> = [];
    var index: usize = 0;
    @limits([Iterations(18)]) while index < record_count {
        let offset = 27 + index * 4;
        records = records.push(
            Event {
                role = fields[offset],
                kind = fields[offset + 1],
                name = fields[offset + 2],
                text = fields[offset + 3]
            }
        );
        index = index + 1;
    }
    let saved = Successor {
        format = 1,
        identity,
        predecessor,
        predecessor_version = fields[6],
        request = fields[7],
        task = fields[8],
        result = fields[9],
        tool = fields[10],
        outcome = fields[11],
        answer = fields[12],
        records,
        usage,
        maximum,
        admitted = 2,
        lifecycle = "completed",
        resolved = true
    };
    return successor_validate(saved, identity, predecessor.identity);
}

public type Identity = {
    id: string,
    workspace: string,
    allowed: Array<string>
};

public type CheckpointRecord = {
    format: i32,
    phase: string,
    identity: Identity,
    body: string
};

public type SuccessorRecord = {
    format: i32,
    phase: string,
    predecessor: Identity,
    successor: Identity,
    predecessor_version: string,
    predecessor_body: string,
    request: string,
    body: string,
    usage: ReadLedger,
    maximum: ReadLedger,
    reserved: ReadLedger,
    admitted: i32,
    resolved: bool
};
