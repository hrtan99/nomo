module nomo.adapters.storage.codec.archive;

import std.json.parse;
import std.agent.message.Message;
import std.crypto.sha256;
import std.codec.text.utf8_encode;
import nomo.domain.serialization.json.encode;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.transfer.archive.{PortableArchive, LegacyArchive, Imported};

public flow json<T>(value: T) -> string {
    return match encode(value, "archive conversion failed", "archive encoding failed") {
        Ok(text) => text, Err(error) => abort(error),
    };
}

public flow decode(raw: string) -> Imported {
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => abort("conversation archive must be JSON"), };
    let native: Option<Message<PortableArchive>> = Message.new(parsed).cast<PortableArchive>();
    match native {
        Some(converted) => {
            let source = converted.body;
            if source.format != "nomo-native-conversation-1" { abort("unsupported native conversation format"); }
            let summary = match source.events.iter().filter(item => item.role == "summary").last() {
                Some(item) => item.text, None() => ""
            };
            return Imported { title = source.session.title, events = source.events, summary };
        }
        None() => (),
    }
    let legacy: Option<Message<LegacyArchive>> = Message.new(parsed).cast<LegacyArchive>();
    let source = match legacy { Some(value) => value.body, None() => abort("unsupported conversation archive shape"), };
    if source.format != "nomo-conversation-1" { abort("unsupported conversation format"); }
    let events = source.events.iter().map(item =>
        ChatMessage { id = "", role = item.role, name = item.name, text = item.content }
    ).collect();
    return Imported { title = source.session.title, events, summary = source.session.summary };
}

public flow fingerprint(raw: string) -> bytes {
    return sha256(utf8_encode(raw));
}
