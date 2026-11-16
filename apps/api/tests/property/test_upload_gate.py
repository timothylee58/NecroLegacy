from hypothesis import given
from hypothesis import strategies as st

from app.services.file_checks import (
    EXECUTABLE_MAGICS,
    IMAGE_EXTENSIONS,
    JPEG_MAGIC,
    MAX_IMAGE_BYTES,
    MAX_TEXT_BYTES,
    PNG_MAGIC,
    TEXT_EXTENSIONS,
    UploadRejection,
    validate_upload,
)

ALLOWED = TEXT_EXTENSIONS + IMAGE_EXTENSIONS
exts = st.sampled_from(ALLOWED + (".exe", ".pdf", ".zip", ""))
cased = exts.flatmap(
    lambda e: st.tuples(st.just(e), st.lists(st.booleans(), min_size=len(e), max_size=len(e))).map(
        lambda t: "".join(c.upper() if u else c for c, u in zip(t[0], t[1], strict=True))
    )
)
heads = st.one_of(
    st.binary(max_size=12),
    st.sampled_from([PNG_MAGIC, JPEG_MAGIC, *EXECUTABLE_MAGICS]).flatmap(
        lambda m: st.binary(max_size=4).map(lambda b: m + b)
    ),
)
sizes = st.one_of(
    st.integers(0, 20_000_000),
    st.sampled_from([MAX_TEXT_BYTES, MAX_TEXT_BYTES + 1, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]),
)


def oracle(name: str, size: int, head: bytes) -> bool:
    ext = name[name.rfind(".") :].lower() if "." in name else ""
    if ext not in ALLOWED:
        return False
    if size > (MAX_IMAGE_BYTES if ext in IMAGE_EXTENSIONS else MAX_TEXT_BYTES):
        return False
    if any(head.startswith(m) for m in EXECUTABLE_MAGICS):
        return False
    png, jpeg = head.startswith(PNG_MAGIC), head.startswith(JPEG_MAGIC)
    if ext == ".png":
        return png
    if ext in (".jpg", ".jpeg"):
        return jpeg
    return not png and not jpeg


# Property 15: Upload gate
@given(ext=cased, stem=st.text(alphabet="abc_", min_size=1, max_size=5), size=sizes, head=heads)
def test_upload_gate(ext, stem, size, head):
    name = stem + ext
    try:
        validate_upload(name, size, head)
        accepted = True
    except UploadRejection:
        accepted = False
    assert accepted == oracle(name, size, head)
