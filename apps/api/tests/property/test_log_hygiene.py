import logging

from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.logging import RedactionFilter

CANARY = "CANARY-7f3a"


# Feature: digital-autopsy-engine, Property 18: Log hygiene
@settings(max_examples=100, deadline=None)
@given(
    level=st.sampled_from([logging.DEBUG, logging.INFO, logging.WARNING, logging.ERROR]),
    field=st.sampled_from(["payload", "content", "text", "bytes"]),
    secret_in_args=st.booleans(),
)
def test_canaries_never_reach_a_handler(level, field, secret_in_args):
    logger = logging.getLogger("necro.property.hygiene")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    seen: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record):
            seen.append(self.format(record) + repr(sorted(record.__dict__)) + repr(record.__dict__))

    handler = Capture()
    handler.addFilter(RedactionFilter([CANARY + "-key"]))
    logger.addHandler(handler)
    extra = {field: CANARY + "-data", "session_id": "s", "size": 3}
    if secret_in_args:
        logger.log(level, "call %s", CANARY + "-key", extra=extra)
    else:
        logger.log(level, "plain", extra=extra)
    assert seen and all(CANARY not in line for line in seen)
