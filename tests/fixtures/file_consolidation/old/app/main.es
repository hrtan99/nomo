module app.main;

import nomo.adapters.storage.processes.ArchivedJobs;
import nomo.domain.process.archived_jobs.ArchivedJob;
import std.codec.text.utf8_encode;

public flow main(args: Array<string>) -> i32 ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let output = utf8_encode("鹈鹕\0\n");
    ArchivedJobs.Jobs.insert("old-job", ArchivedJob { id = "old-job", workspace = "/synthetic-project",
        arguments = ["/bin/echo", "saved"], phase = "unknown", exit_code = None(),
        output_bytes = 8, parts = 1, original = "saved original metadata" });
    ArchivedJobs.Parts.insert("old-job/0", output);
    return 0;
}
