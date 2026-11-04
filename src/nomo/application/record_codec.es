module nomo.application.record_codec;

// Write-only consumers need no decoding authority. Round-trip consumers use
// the full versioned codec contract without owning a concrete record format.
public spec RecordEncoder<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>];
}

public spec RecordCodec<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>];
    flow decode(self, raw: string) -> Result<T, string> ![Error<IndexError>];
}

public flow encode_record<T, E ~ RecordEncoder<T>>(encoder: E, value: T) -> Result<string, string> ![Error<IndexError>] {
    return encoder.encode(value);
}

public flow decode_record<T, C ~ RecordCodec<T>>(codec: C, raw: string) -> Result<T, string> ![Error<IndexError>] {
    return codec.decode(raw);
}
