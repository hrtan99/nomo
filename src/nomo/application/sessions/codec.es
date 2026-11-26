module nomo.application.sessions.codec;




// Write-only consumers need no decoding authority. Round-trip consumers use
// the full versioned codec contract without owning a concrete record format.
public spec RecordEncoder<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>];
}

public spec RecordCodec<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>];
    flow decode(self, raw: string) -> Result<T, string> ![Error<IndexError>, Error<BudgetExceeded>];
}

public flow encode_record<T, E ~ RecordEncoder<T>>(encoder: E, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
    return encoder.encode(value);
}

public flow decode_record<T, C ~ RecordCodec<T>>(codec: C, raw: string) -> Result<T, string> ![Error<IndexError>, Error<BudgetExceeded>] {
    return codec.decode(raw);
}
