module nomo.adapters.storage.codec.archive_role;

import nomo.domain.transfer.archive.{ArchiveDocument, Imported};
import nomo.application.transfer.ports.ArchiveEncoding;
import nomo.adapters.storage.codec.archive.{json, decode as decode_archive, fingerprint as hash_archive};

public type JsonArchiveEncoding = {};
impl JsonArchiveEncoding ~ ArchiveEncoding {
    flow encode(self, document: ArchiveDocument) -> string ![] {
        return match document { ArchiveDocument.Metadata(value) => json(value), ArchiveDocument.Conversation(value) => json(value), ArchiveDocument.Outcome(value) => json(value) };
    }
    flow decode(self, raw: string) -> Imported ![] { return decode_archive(raw); }
    flow fingerprint(self, raw: string) -> bytes ![] { return hash_archive(raw); }
}
