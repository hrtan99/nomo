module app.main;

import nomo.adapters.filesystem.migration.RelocatedStatePacket;
import nomo.adapters.storage.legacy.user_context_chain_v4_journal.UserContextJournal;
import nomo.adapters.storage.legacy.user_context_chain_v4_store.UserContextChain;
import nomo.adapters.storage.migration.{NativeStateWriter, restore_relocated};
import nomo.application.resources.MigrationRoot;
import nomo.application.transfer.migration.relocated_state_migrate;
import nomo.application.transfer.ports.RelocatedStateDestination;
import nomo.domain.archives.RelocatedRow;
import nomo.domain.wire.encode;
import std.effects.Fs;
import std.io.println;

type Destination = {};
impl Destination ~ RelocatedStateDestination {
    flow insert(self, row: RelocatedRow) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        match row.store {
            "nomo-user-context-edit-v4/Rows" => restore_relocated(UserContextJournal.Rows, row),
            "nomo-user-context-chain-v4/Rows" => restore_relocated(UserContextChain.Rows, row),
            _ => {
                let destination = NativeStateWriter {};
                destination.insert(row);
            },
        }
    }
}

public flow main(args: Array<string>) -> i32 ![
    Fs.read<MigrationRoot>,
    Memory,
    Console,
    Error<std.fs.IOError>,
    Error<std.fs.ReadLimitError>,
    Error<IndexError>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<std.io.IOError>
] {
    let report = relocated_state_migrate(RelocatedStatePacket {}, Destination {});
    println(
        "[MIGRATE] "
            + match encode(report, "relocation report conversion failed", "relocation report encoding failed") {
            Ok(value) => value,
            Err(error) => abort(error)
        }
    );
    return 0;
}
