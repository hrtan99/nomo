module nomo.session.harness_checkpoint;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
public type Identity = { id: string, workspace: string, allowed: Array<string> };
