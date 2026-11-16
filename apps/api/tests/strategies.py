from hypothesis import strategies as st

from app.schemas.autopsy import NODE_ORDER

node_names = st.sampled_from(NODE_ORDER)
scores = st.floats(min_value=0.0, max_value=1.0, allow_nan=False)
safe_text = st.text(alphabet=st.characters(min_codepoint=32, max_codepoint=126), max_size=40)


@st.composite
def non_terminal_events(draw):
    kind = draw(st.sampled_from(["started", "skipped", "failed", "fallback", "error"]))
    node = draw(node_names)
    if kind == "started":
        return ("node", {}, node, "started")
    if kind == "skipped":
        return ("node", {"reason": draw(safe_text)}, node, "skipped")
    if kind == "failed":
        return ("node", {"code": draw(safe_text), "message": draw(safe_text)}, node, "failed")
    if kind == "fallback":
        return (
            "fallback",
            {"failed_provider": "ilmu", "reason": draw(st.sampled_from(["error", "timeout", "validation"]))},
            None,
            None,
        )
    return ("error", {"node": node, "code": draw(safe_text), "message": draw(safe_text)}, None, None)
