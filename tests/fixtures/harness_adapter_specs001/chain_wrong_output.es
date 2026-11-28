module app.callable_negative;
import nomo.domain.harness.read.ReadContext;
import nomo.domain.harness.work.Context as WorkContext;
import nomo.domain.sessions.chain.ParentFacts;
import nomo.application.harness.ports.ReadMainStage;
import nomo.application.harness.ports.EditTextStage;
import nomo.application.harness.ports.ChainEditStage;
flow bad(context: WorkContext, parent: Array<ParentFacts>) -> bool ~ ChainEditStage { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
