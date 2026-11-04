module nomo.session.harness_checkpoint_codec;

import nomo.application.record_codec.{RecordEncoder, RecordCodec};
import nomo.session.harness_checkpoint.{Checkpoint, encode as encode_checkpoint, decode as decode_checkpoint};

public type CheckpointEncoder = {};
public type CheckpointCodec = {};

impl CheckpointEncoder ~ RecordEncoder<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>] { return encode_checkpoint(value); }
}

impl CheckpointCodec ~ RecordCodec<Checkpoint> {
    flow encode(self, value: Checkpoint) -> Result<string, string> ![Error<IndexError>] { return encode_checkpoint(value); }
    flow decode(self, raw: string) -> Result<Checkpoint, string> ![Error<IndexError>] { return decode_checkpoint(raw); }
}
