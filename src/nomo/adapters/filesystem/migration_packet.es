module nomo.adapters.filesystem.migration_packet;

import std.effects.Fs;
import std.fs.{path, read_bytes_limited, IOError as FileError, ReadLimitError};
import std.codec.text.{utf8_decode, Strict};
import std.json.parse;
import std.agent.message.Message;
import std.text.{parse_i64, parse_usize};
import nomo.application.migration.ports.MigrationRoot;

public flow decode<T>(text: string) -> T {
    let json = match parse(text) { Ok(value) => value, Err(_) => abort("migration packet is not JSON"), };
    let typed: Option<Message<T>> = Message.new(json).cast<T>();
    return match typed { Some(value) => value.body, None() => abort("migration packet has an invalid stored value"), };
}
public flow integer(text: string) -> i64 {
    return match parse_i64(text) { Ok(value) => value, Err(_) => abort("migration i64 is invalid"), };
}
public flow size(text: string) -> usize {
    return match parse_usize(text) { Ok(value) => value, Err(_) => abort("migration usize is invalid"), };
}
public flow read<T>() -> T ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>] {
    let source = match path<MigrationRoot>("snapshot.json") { Ok(value) => value, Err(_) => abort("migration packet path is unavailable"), };
    let text = match utf8_decode(read_bytes_limited(source, 536870912), Strict) {
        Ok(value) => value, Err(_) => abort("migration packet is not UTF-8"),
    };
    return decode<T>(text);
}
