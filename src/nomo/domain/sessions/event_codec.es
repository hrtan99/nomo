module nomo.domain.sessions.event_codec;

import nomo.domain.conversation.Event;
import nomo.domain.harness.chat.{Previous, chat_policy_prior_error};
import nomo.domain.harness.read.question_error;
import nomo.domain.limits.{event_bytes, history_bytes, message_bytes, outcome_bytes};
import nomo.domain.text.{data_safe, flat_string_frame, safe, text_printable};
import nomo.domain.wire.{encode, string_fields};
import std.agent.message.Message;
import std.json.parse;
import std.text.{char_count, concat, contains, count, get_byte_slice, is_ascii, is_char_boundary, len, replace};

public type Bundle = {
    format: i32,
    session_id: string,
    save_id: string,
    bodies: Array<string>
};

// One array root plus at most 35 string leaves. No recursive decoder or generic
// object projection: field positions are marker, session ID, save ID, then bodies.
// Check encoded bytes and shape before allocating a parsed JSON tree/cast result.
flow framed(json: string) -> bool {
    return flat_string_frame(json, 35, false);
}

flow bundle_error(bundle: Bundle) -> string {
    if bundle.format != 1 {
        return "unsupported bundle format";
    }
    if char_count(bundle.session_id) == 0 || char_count(bundle.session_id) > 128
        || char_count(bundle.save_id) == 0 || char_count(bundle.save_id) > 128 {
        return "invalid bundle identity";
    }
    if !text_printable(bundle.session_id) || !text_printable(bundle.save_id) {
        return "invalid bundle identity";
    }
    if bundle.bodies.len() > 32 {
        return "bundle body count exceeds limit";
    }
    var characters: usize = 0;
    @limits([Iterations(32)]) for body in bundle.bodies {
        if char_count(body) > history_bytes() {
            return "bundle aggregate text exceeds limit";
        }
        characters = characters + char_count(body);
        if characters > history_bytes() {
            return "bundle aggregate text exceeds limit";
        }
    }
    return "";
}

public flow bundle_codec_encode(bundle: Bundle) -> Result<string, string> {
    let error = bundle_error(bundle);
    if error != "" {
        return Err(error);
    }
    let fields = ["nomo-session-bundle-v1", bundle.session_id, bundle.save_id].extend(bundle.bodies);
    // Public checked Message.cast performs typed HostValue/JsonValue conversion;
    // these helpers issue no Host request and never attach a Session configuration.
    let json = match encode(fields, "bundle checked encoding failed", "bundle JSON encoding failed") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !framed(json) {
        return Err("bundle encoded bounds exceeded");
    }
    return Ok(json);
}

public flow bundle_codec_decode(json: string) -> Result<Bundle, string> {
    if !framed(json) {
        return Err("bundle encoded shape or bounds invalid");
    }
    let fields = match string_fields(json, "bundle JSON invalid", "bundle must contain only strings") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if fields.len() < 3 || fields.len() > 35 {
        return Err("bundle field count invalid");
    }
    if fields[0] != "nomo-session-bundle-v1" {
        return Err("unsupported bundle format");
    }
    let bodies = fields.iter().skip(3).collect();
    let bundle = Bundle {
        format = 1,
        session_id = fields[1],
        save_id = fields[2],
        bodies
    };
    let error = bundle_error(bundle);
    if error != "" {
        return Err(error);
    }
    return Ok(bundle);
}

// Canonical JSON string notation is reversible for LF, CR, TAB, quotes and
// backslashes. Filtering happens on decoded text before encoding. Unsupported
// or overlong encoded text is refused, never silently truncated.
public type Encoded = {
    value: string,
    replacements: usize
};

public flow event_text_codec_encode(text: string, policy: Policy) -> Result<Encoded, string> {
    let clean = match redact_text(text, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if len(clean.value) > outcome_bytes() {
        return Err("event text exceeds decoded bound");
    }
    let encoded = match encode(
        clean.value,
        "event text JSON conversion refused",
        "event text JSON encoding refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if len(encoded) > event_bytes() || (!is_ascii(encoded) && !safe(encoded, event_bytes())) {
        return Err("encoded event text unsupported or exceeds bound");
    }
    return Ok(Encoded {
        value = encoded,
        replacements = clean.replacements
    });
}

public flow event_text_codec_decode(encoded: string, policy: Policy) -> Result<string, string> {
    if len(encoded) > event_bytes() || (!is_ascii(encoded) && !safe(encoded, event_bytes())) {
        return Err("invalid encoded event text");
    }
    let value = match parse(encoded) {
        Ok(item) => item,
        Err(_) => {
            return Err("invalid event text JSON");
        }
    };
    let converted: Option<Message<string>> = Message.new(value).cast<string>();
    let raw = match converted {
        Some(item) => item.body,
        None() => {
            return Err("event text JSON is not a string");
        }
    };
    let canonical = match event_text_codec_encode(raw, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if canonical.replacements != 0 || canonical.value != encoded {
        return Err("event text is noncanonical or contains a known sensitive literal");
    }
    return Ok(raw);
}

// Filter the complete bounded stream before taking an excerpt. If the
// host cannot transfer the complete capture, it supplies an empty stream and
// the truncation flag instead of a potentially sensitive partial literal.
public type Prefix = {
    value: string,
    truncated: bool
};

public flow encode_prefix(text: string, truncated: bool, policy: Policy) -> Result<Prefix, string> {
    let clean = match redact_text(text, policy) {
        Ok(item) => item.value,
        Err(error) => {
            return Err(error);
        }
    };
    let size = len(clean);
    let clipped = truncated || size > message_bytes();
    if size <= message_bytes() {
        let encoded = match event_text_codec_encode(clean, policy) {
            Ok(item) => item.value,
            Err(error) => {
                return Err(error);
            }
        };
        return Ok(Prefix {
            value = encoded,
            truncated = clipped
        });
    }
    let encoded = match event_text_codec_encode(excerpt(clean), policy) {
        Ok(item) => item.value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Prefix {
        value = encoded,
        truncated = clipped
    });
}

// Only already-redacted output above the whole-message bound reaches here.
flow excerpt(clean: string) -> string {
    let size = len(clean);
    var head: usize = 2000;
    var tail = size - 2000;
    // UTF-8 has at most three continuation bytes at either boundary.
    for _ in [0, 1, 2] {
        if is_char_boundary(clean, head) {
            break;
        }
        head = head - 1;
    }
    for _ in [0, 1, 2] {
        if is_char_boundary(clean, tail) {
            break;
        }
        tail = tail + 1;
    }
    return concat(
        [
            get_byte_slice(clean, [0, head)).unwrap(),
            "\n[... output omitted ...]\n",
            get_byte_slice(clean, [tail, size)).unwrap()
        ]
    );
}

// The caller must provide known sensitive literals through a trusted private
// boundary. This is exact-match redaction only, not detection of all secrets.
public type Policy = {
    format: i32,
    literals: Array<string>
};

public type Text = {
    value: string,
    replacements: usize
};

public type PreviousData = {
    request: string,
    previous: Previous,
    replacements: usize
};

public type Events = {
    events: Array<Event>,
    replacements: usize
};

public flow policy_error(policy: Policy) -> string {
    if policy.format != 1 || policy.literals.len() == 0 || policy.literals.len() > 8 {
        return "invalid redaction policy";
    }
    var i: usize = 0;
    @limits([Iterations(8)]) for literal in policy.literals {
        let bytes = len(literal);
        if bytes < 8 || bytes > 256 || !safe(literal, 256) {
            return "invalid redaction literal";
        }
        var j: usize = 0;
        @limits([Iterations(8)]) for other in policy.literals {
            if i != j && (contains(literal, other) || contains(other, literal)) {
                return "overlapping redaction literals";
            }
            j = j + 1;
        }
        i = i + 1;
    }
    return "";
}

public flow redact_text(value: string, policy: Policy) -> Result<Text, string> {
    let policy_problem = policy_error(policy);
    if policy_problem != "" {
        return Err(policy_problem);
    }
    if len(value) > event_bytes() {
        return Err("redaction input exceeds bound");
    }
    var output = value;
    var replacements: usize = 0;
    @limits([Iterations(8)]) for literal in policy.literals {
        let matches = count(output, literal);
        if matches > 0 {
            replacements = replacements + matches;
            output = replace(output, literal, "[REDACTED]");
        }
        if len(output) > event_bytes() {
            return Err("redaction output exceeds bound");
        }
    }
    @limits([Iterations(8)]) for literal in policy.literals {
        if contains(output, literal) {
            return Err("redaction result still contains sensitive literal");
        }
    }
    return Ok(Text {
        value = output,
        replacements
    });
}

public flow previous(request: string, prior: Previous, policy: Policy) -> Result<PreviousData, string> {
    let req = match redact_text(request, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let task = match redact_text(prior.task, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let result = match redact_text(prior.result, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let tool = match redact_text(prior.tool, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let outcome = match redact_text(prior.outcome, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let answer = match redact_text(prior.answer, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let projected = Previous {
        task = task.value,
        result = result.value,
        tool = tool.value,
        outcome = outcome.value,
        answer = answer.value
    };
    if question_error(req.value) != "" || chat_policy_prior_error(projected) != "" {
        return Err("redacted history violates its bounds");
    }
    return Ok(
        PreviousData {
            request = req.value,
            previous = projected,
            replacements = req.replacements + task.replacements + result.replacements + tool.replacements
                + outcome.replacements + answer.replacements
        }
    );
}

public flow events(value: Array<Event>, policy: Policy) -> Result<Events, string> {
    let problem = policy_error(policy);
    if problem != "" {
        return Err(problem);
    }
    if value.len() > 24 {
        return Err("too many historical events");
    }
    var output: Array<Event> = [];
    var replacements: usize = 0;
    @limits([Iterations(24)]) for event in value {
        if !safe(event.role, 128) || !safe(event.kind, 128) || !safe(event.name, 128) {
            return Err("invalid historical event metadata");
        }
        @limits([Iterations(8)]) for literal in policy.literals {
            if contains(event.role, literal) || contains(event.kind, literal) || contains(event.name, literal) {
                return Err("sensitive literal in event metadata");
            }
        }
        let clean = match redact_text(event.text, policy) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        if !data_safe(clean.value, event_bytes()) {
            return Err("redacted event text violates bounds");
        }
        output = output.push(event {
            text = clean.value
        });
        replacements = replacements + clean.replacements;
    }
    return Ok(Events {
        events = output,
        replacements
    });
}

// Only a trusted caller's known literals are redacted. No policy or literal is
// stored here. This isolated store is not yet linked atomically to chat turns.
public type History = {
    format: i32,
    turns: i32,
    first_count: usize,
    events: Array<Event>
};

// A pure, bounded projection. This does not persist events or grant authority.
// Exact known-literal filtering is not comprehensive secret detection; callers
// must supply an appropriate trusted policy before using any persisted form.
public type EventFrame = {
    format: i32,
    turns: i32,
    first_count: usize,
    events: Array<Event>
};
