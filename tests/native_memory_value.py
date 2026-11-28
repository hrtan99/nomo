"""Read this fixture's ETS1 values using the pinned std.memory.binary layout.

Test observation only; Nomo continues to use the official typed Memory codec.
"""
from io import BytesIO


class Reader:
    def __init__(self, data):
        self.input = BytesIO(data)

    def integer(self, width=8, signed=False):
        data = self.input.read(width)
        assert len(data) == width
        return int.from_bytes(data, 'little', signed=signed)

    def blob(self):
        length = self.integer()
        data = self.input.read(length)
        assert len(data) == length
        return data

    def text(self):
        return self.blob().decode()

    def value(self):
        tag = self.integer(1)
        if tag == 0:
            return None
        if tag == 1:
            return bool(self.integer(1))
        if 16 <= tag <= 21 or 24 <= tag <= 29:
            width = self.integer(1) if tag in (21, 29) else 1 << (tag % 8)
            return self.integer(width, signed=tag < 24)
        if tag == 48:
            return self.text()
        if tag == 49:
            return self.blob()
        if 64 <= tag <= 71:
            return [self.value() for _ in range(self.integer())]
        if tag == 80:
            return {self.text(): self.value() for _ in range(self.integer())}
        if tag == 81:
            self.text()
            return self.value()
        if tag == 82:
            self.text()
            name = self.text()
            return {'name': name, 'fields': [self.value() for _ in range(self.integer())]}
        raise AssertionError(f'unexpected fixture storage tag: {tag}')


def value(raw):
    assert raw['kind'] == 'bytes'
    reader = Reader(bytes(raw['value']))
    header = reader.input.read(5)
    assert header[:4] == b'ETS\x01' and header[4] in (0, 1)
    reader.text()  # checked schema identity, retained by the native runtime
    result = reader.value()
    assert reader.input.read() == b''
    return result
