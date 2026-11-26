module nomo.adapters.storage.codec.harness_successor;

import nomo.application.sessions.codec.{RecordEncoder, RecordCodec};
import nomo.domain.sessions.harness_successor.{Successor, encode as encode_successor, decode as decode_successor};

public type SuccessorEncoder = {};

public type SuccessorCodec = {};

impl SuccessorEncoder ~ RecordEncoder<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] { return encode_successor(value); }
}

impl SuccessorCodec ~ RecordCodec<Successor> {
    flow encode(self, value: Successor) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] { return encode_successor(value); }
    flow decode(self, raw: string) -> Result<Successor, string> ![Error<IndexError>, Error<BudgetExceeded>] { return decode_successor(raw); }
}
