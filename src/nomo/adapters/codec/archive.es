module nomo.adapters.codec.archive;

import std.json.parse;
import std.agent.message.Message;
import std.crypto.sha256;
import std.codec.text.utf8_encode;
import nomo.core.json.encode;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.transfer.archive.{PortableArchive, LegacyArchive, Imported};

public flow json<T>(value: T) -> string {
    return match encode(value, "archive conversion failed", "archive encoding failed") {
        Ok(text) => text, Err(error) => { abort(error); }
    };
}

public flow decode(raw: string) -> Imported {
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { abort("conversation archive must be JSON"); } };
    let native: Option<Message<PortableArchive>> = Message.new(parsed).cast<PortableArchive>();
    match native {
        Some(converted) => {
            let source = converted.body;
            if source.format != "nomo-native-conversation-1" { abort("unsupported native conversation format"); }
            var summary = "";
            for item in source.events limit Iterations(2147483647) { if item.role == "summary" { summary = item.text; } }
            return Imported { title = source.session.title, events = source.events, summary = summary };
        }
        None() => {}
    }
    let legacy: Option<Message<LegacyArchive>> = Message.new(parsed).cast<LegacyArchive>();
    let source = match legacy { Some(value) => value.body, None() => { abort("unsupported conversation archive shape"); } };
    if source.format != "nomo-conversation-1" { abort("unsupported conversation format"); }
    var events: Array<ChatMessage> = [];
    for item in source.events limit Iterations(2147483647) {
        events = events.push(ChatMessage { id = "", role = item.role, name = item.name, text = item.content });
    }
    return Imported { title = source.session.title, events = events, summary = source.session.summary };
}

public flow fingerprint(raw: string) -> bytes {
    let converted: Option<Message<bytes>> = Message.new(sha256(utf8_encode(raw))).cast<bytes>();
    return match converted { Some(value) => value.body, None() => { abort("native SHA-256 representation unavailable"); } };
}
