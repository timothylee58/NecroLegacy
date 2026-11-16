import logging

from app.core.logging import RedactionFilter


def make_logger(secrets=()):
    logger = logging.getLogger("necro.test.redaction")
    logger.handlers.clear()
    logger.propagate = False
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = Capture()
    handler.addFilter(RedactionFilter(secrets))
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    return logger, records


def test_forbidden_extras_dropped_and_allowed_kept():
    logger, records = make_logger()
    logger.info(
        "done", extra={"payload": "x", "content": "x", "text": "x", "bytes": b"x", "session_id": "s1", "size": 4}
    )
    r = records[0]
    assert not any(hasattr(r, k) for k in ("payload", "content", "text", "bytes"))
    assert r.session_id == "s1" and r.size == 4


def test_secret_values_masked_in_message_and_args():
    logger, records = make_logger(["tok-123"])
    logger.warning("auth with %s failed", "tok-123")
    assert "tok-123" not in records[0].getMessage()
