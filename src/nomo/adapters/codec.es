module nomo.adapters.codec;

import nomo.domain.archives.wire_export_outcome;
import nomo.domain.archives.wire_metadata;
import nomo.domain.conversation.wire_model_turn;
import nomo.application.conversation.ports.ContextProjection;
import nomo.application.sessions.ports.{RecordCodec, RecordEncoder};
import nomo.application.transfer.ports.ArchiveEncoding;
import nomo.application.workspace.ports.{ConfigurationOutput, EntriesCodec};
import nomo.domain.archives.{ArchiveDocument, Imported, LegacyArchive, PortableArchive};
import nomo.domain.context.should_compact;
import nomo.domain.conversation.{ChatMessage, ModelTurn};
import nomo.domain.harness.edit.history_bound;
import nomo.domain.sessions.checkpoints.{Checkpoint, Successor, checkpoint_decode, checkpoint_encode, successor_decode, successor_encode};
import nomo.domain.settings.{Settings, defaults, validate};
import nomo.domain.wire.encode;
import std.agent.message.Message;
import std.agent.prompt.{PromptEncode, PromptPart};
import std.codec.text.utf8_encode;
import std.crypto.sha256;
import std.json.{JsonValue, parse};
import std.text.len;

public type JsonConfigurationCodec = {};

impl JsonConfigurationCodec ~ EntriesCodec {
    flow fingerprint(self, raw: string) -> bytes ![] {
        return configuration_fingerprint(raw);
    }

    flow decode_json(self, text: string) -> Settings ![] {
        return configuration_decode(text);
    }

    flow observation(self, text: string) -> ConfigurationOutput ![] {
        return observation(text);
    }
}

public type RollingContext = {};

impl RollingContext ~ ContextProjection {
    flow bytes(self, input: ModelTurn) -> usize {
        let json = match encode(
            wire_model_turn(input),
            "context conversion failed",
            "context encoding failed"
        ) {
            Ok(value) => value,
            Err(error) => abort(error),
        };
        return len(json);
    }

    flow needs_compaction(self, input: ModelTurn) -> bool {
        return should_compact(input, self.bytes(input));
    }
}

// Keep framework encoding at the model boundary; domain and stored types stay passive.
public type JsonInput<T> = {
    value: T
};

impl JsonInput<T> ~ PromptEncode {
    public flow encode(self) -> PromptPart ![] {
        let text = match encode(
            self.value,
            "model input conversion failed",
            "model input JSON encoding failed"
        ) {
            Ok(text) => text,
            Err(error) => abort(error),
        };
        return PromptPart {
            text
        };
    }
}

public flow input<T>(value: T) -> JsonInput<T> ![] {
    return JsonInput {
        value
    };
}

public flow json<T>(value: T) -> string {
    return match encode(value, "archive conversion failed", "archive encoding failed") {
        Ok(text) => text,
        Err(error) => abort(error),
    };
}

public flow archive_decode(raw: string) -> Imported {
    let parsed = match parse(raw) {
        Ok(value) => value,
        Err(_) => abort("conversation archive must be JSON"),
    };
    let native: Option<Message<PortableArchive>> = Message.new(parsed).cast<PortableArchive>();
    match native {
        Some(converted) => {
            let source = converted.body;
            if source.format != "nomo-native-conversation-1" {
                abort("unsupported native conversation format");
            }
            let summary = match source.events.iter().filter(item => item.role == "summary").last() {
                Some(item) => item.text,
                None() => ""
            };
            return Imported {
                title = source.session.title,
                events = source.events,
                summary
            };
        }
        None() => (),
    }
    let legacy: Option<Message<LegacyArchive>> = Message.new(parsed).cast<LegacyArchive>();
    let source = match legacy {
        Some(value) => value.body,
        None() => abort("unsupported conversation archive shape"),
    };
    if source.format != "nomo-conversation-1" {
        abort("unsupported conversation format");
    }
    let events = source.events.iter().map(
        item =>
        ChatMessage {
            id = "",
            role = item.role,
            name = item.name,
            text = item.content
        }
    ).collect();
    return Imported {
        title = source.session.title,
        events,
        summary = source.session.summary
    };
}

public flow archive_fingerprint(raw: string) -> bytes {
    return sha256(utf8_encode(raw));
}

public type JsonArchiveEncoding = {};

impl JsonArchiveEncoding ~ ArchiveEncoding {
    flow encode(self, document: ArchiveDocument) -> string ![] {
        return match document {
            ArchiveDocument.Metadata(value) => json(wire_metadata(value)),
            ArchiveDocument.Conversation(value) => json(value),
            ArchiveDocument.Outcome(value) => json(wire_export_outcome(value))
        };
    }

    flow decode(self, raw: string) -> Imported ![] {
        return archive_decode(raw);
    }

    flow fingerprint(self, raw: string) -> bytes ![] {
        return archive_fingerprint(raw);
    }
}

type Entry = {
    key: string,
    value: JsonValue
};

flow cast<T>(value: JsonValue, label: string) -> T {
    let result: Option<Message<T>> = Message.new(value).cast<T>();
    return match result {
        Some(value) => value.body,
        None() => abort("project configuration has an invalid field type: " + label),
    };
}

flow field<T>(values: Array<Entry>, name: string, fallback: T) -> T {
    return match values.iter().find(entry => entry.key == name) {
        Some(entry) => cast<T>(entry.value, name),
        None() => fallback,
    };
}

public flow configuration_decode(text: string) -> Settings {
    let root = match parse(text) {
        Ok(value) => cast<Array<Entry>>(value, "root entries"),
        Err(_) => abort("TOML decoder returned invalid JSON"),
    };
    let values = match root.iter().find(entry => entry.key == "project") {
        Some(entry) => cast<Array<Entry>>(entry.value, "project entries"),
        None() => root,
    };
    let base = defaults();
    let settings = Settings {
        context_window = field(values, "context_window", base.context_window),
        max_output_tokens = field(values, "max_output_tokens", base.max_output_tokens),
        compact_ratio = field(values, "compact_ratio", base.compact_ratio),
        keep_messages = field(values, "keep_messages", base.keep_messages),
        command_timeout = field(values, "command_timeout", base.command_timeout),
        ignore = field(values, "ignore", base.ignore),
        instructions = field(values, "instructions", base.instructions),
        check = field(values, "check", base.check)
    };
    return validate(settings);
}

public flow configuration_fingerprint(text: string) -> bytes {
    return sha256(utf8_encode(text));
}

public flow observation(text: string) -> ConfigurationOutput {
    return match parse(text) {
        Ok(value) => cast<ConfigurationOutput>(value, "cached observation"),
        Err(_) => abort("configuration observation is not JSON"),
    };
}

public type CheckpointEncoder = {};

public type CheckpointCodec = {};

impl CheckpointEncoder ~ RecordEncoder<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return checkpoint_encode(value);
    }
}

impl CheckpointCodec ~ RecordCodec<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return checkpoint_encode(value);
    }

    flow decode(self, raw: string) -> Result<Checkpoint, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return checkpoint_decode(raw);
    }
}

public type SuccessorEncoder = {};

public type SuccessorCodec = {};

impl SuccessorEncoder ~ RecordEncoder<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return successor_encode(value);
    }
}

impl SuccessorCodec ~ RecordCodec<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return successor_encode(value);
    }

    flow decode(self, raw: string) -> Result<Successor, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return successor_decode(raw);
    }
}

// Preserve the concrete input and all evidence; only verify its encoded bound.
public flow bounded_history<T>(value: T, kind: string) -> T {
    let converted: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    history_bound(converted, 33554432, kind);
    return value;
}
