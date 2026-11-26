module nomo.adapters.cli.transfer;

import std.io.{println, IOError};
import std.text.from_i64;
import nomo.domain.transfer.archive.ExportPreview;
import nomo.adapters.storage.codec.archive.json;
import nomo.application.transfer.ports.TransferRenderer;

public type TerminalTransfer = {};
impl TerminalTransfer ~ TransferRenderer {
    flow progress(self, id: string, copied: i64, total: i64) -> unit ![Console, Error<IOError>] { println("[COPY   ] " + id + " " + from_i64(copied) + "/" + from_i64(total)); }
    flow preview(self, value: ExportPreview) -> unit ![Console, Error<IOError>] { println("[EXPORT ] " + json(value)); }
    flow exported(self, path: string) -> unit ![Console, Error<IOError>] { println("[EXPORTED] " + path); }
}
