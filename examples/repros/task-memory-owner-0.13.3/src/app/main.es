module app.main;
import std.task.{run, start, Scheduler};
import std.io.{println, read_line, IOError};
alias Schema = MemoryRegion<{ Values: Store<string, i32> }>;
let Owner = std.memory.region<Schema>(stable_id = "owner-records", store = "owner");
let Peer = std.memory.region<Schema>(stable_id = "peer-records", store = "peer");
flow main(args: Array<string>) -> i32
    ![Async, Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return run((scheduler: Scheduler) => {
        Owner.Values.put("owner", 1);
        let child = start(() => {
            Peer.Values.put("peer", 1);
            println("CHILD_RAN");
            return 0;
        });
        println("WAIT_INPUT");
        read_line();
        return 0;
    });
}
