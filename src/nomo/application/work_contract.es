module nomo.application.work_contract;

// Compatibility facade for external fixtures. Product code imports the
// responsibility-owned modules directly.
public import nomo.application.work.request.WorkRequest;
public import nomo.application.work.ports.{Failure, Pending, Completed, Summary, WorkStages, WorkPersistence, WorkEditor, WorkTimeline, Run};
public import nomo.application.harness.work.ports.WorkModelStages;
