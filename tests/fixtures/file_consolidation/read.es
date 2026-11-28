module app.main;

import nomo.adapters.storage.jobs.NativeJobs;
import nomo.application.execution.ports.{ArchivedJobCatalog, ArchivedJobParts};
import nomo.domain.processes.ArchivedJobPhase;
import std.codec.text.utf8_encode;
import std.io.println;
import std.io.IOError;

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<BudgetExceeded>, Error<IOError>] {
    let jobs = NativeJobs {};
    let saved = match jobs.archived_job("old-job") { Some(value) => value, None() => abort("old job missing") };
    if saved.id != "old-job" || saved.workspace != "/synthetic-project" || saved.arguments != ["/bin/echo", "saved"] ||
        saved.phase != ArchivedJobPhase.Unknown || saved.exit_code != None() || saved.parts != 1 || saved.output_bytes != 8 ||
        saved.original != "saved original metadata" { abort("old stored job changed"); }
    if jobs.archived_jobs("/synthetic-project") != [saved] { abort("old job catalogue changed"); }
    if jobs.archived_part("old-job", 0) != Some(utf8_encode("鹈鹕\0\n")) { abort("old raw bytes changed"); }
    println("PASS prior ArchivedJob and exact raw output");
    return 0;
}
