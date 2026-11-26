module nomo.adapters.storage.codec.harness_checkpoint;

import nomo.application.sessions.codec.{RecordEncoder, RecordCodec};
import nomo.domain.sessions.harness_checkpoint.{Checkpoint, encode as encode_checkpoint, decode as decode_checkpoint};

public type CheckpointEncoder = {};

public type CheckpointCodec = {};

impl CheckpointEncoder ~ RecordEncoder<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] { return encode_checkpoint(value); }
}

impl CheckpointCodec ~ RecordCodec<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] { return encode_checkpoint(value); }
    flow decode(self, raw: string) -> Result<Checkpoint, string> ![Error<IndexError>, Error<BudgetExceeded>] { return decode_checkpoint(raw); }
}
