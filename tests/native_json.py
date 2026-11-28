"""Lossless byte-array observation for integral JSON number spellings."""


def byte_values(values):
    decoded = bytes(map(int, values))
    assert list(decoded) == values
    return decoded
