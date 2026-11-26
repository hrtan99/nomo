module nomo.adapters.filesystem.transfer_tools;

import nomo.domain.conversation.session.Session;
import nomo.domain.transfer.copy.CopyJob;
import nomo.application.transfer.effects.TransferOperations;

public flow save_archive(session: string, pathname: string) -> unit ![TransferOperations] { perform TransferOperations.save(session, pathname); }
public flow load_archive(workspace: string, pathname: string) -> Session ![TransferOperations] { return perform TransferOperations.load(workspace, pathname); }
public flow resume_import(workspace: string, id: string) -> Session ![TransferOperations] { return perform TransferOperations.resume_import(workspace, id); }
public flow fork(id: string, through: i64) -> Session ![TransferOperations] { return perform TransferOperations.fork(id, through); }
public flow resume_fork(workspace: string, id: string) -> Session ![TransferOperations] { return perform TransferOperations.resume_fork(workspace, id); }
public flow discard_copy(workspace: string, id: string) -> unit ![TransferOperations] { perform TransferOperations.discard(workspace, id); }
public flow copy_status(id: string) -> Option<CopyJob> ![TransferOperations] { return perform TransferOperations.status(id); }
public flow copy_jobs(workspace: string) -> Array<CopyJob> ![TransferOperations] { return perform TransferOperations.copies(workspace); }
public flow copy_job(id: string) -> CopyJob ![TransferOperations] { return perform TransferOperations.job(id); }
