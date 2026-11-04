module nomo.session.harness_successor_codec;

import nomo.application.record_codec.{RecordEncoder, RecordCodec};
import nomo.session.harness_successor.{Successor, encode as encode_successor, decode as decode_successor};

public type SuccessorEncoder = {};
public type SuccessorCodec = {};

impl SuccessorEncoder ~ RecordEncoder<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>] { return encode_successor(value); }
}

impl SuccessorCodec ~ RecordCodec<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>] { return encode_successor(value); }
    flow decode(self, raw: string) -> Result<Successor, string> ![Error<IndexError>] { return decode_successor(raw); }
}
