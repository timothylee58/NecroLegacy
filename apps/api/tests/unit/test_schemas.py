import pytest
from pydantic import ValidationError

from app.schemas.autopsy import BoundingBox, PrimaryKey, SearchRequest, VisionResult, payload_model


def test_score_rounds_to_two_places_and_rejects_out_of_range():
    assert PrimaryKey(field="a", confidence=0.12345).confidence == 0.12
    with pytest.raises(ValidationError):
        PrimaryKey(field="a", confidence=1.01)


def test_bbox_requires_positive_size_and_forbids_extras():
    with pytest.raises(ValidationError):
        BoundingBox(x=0, y=0, width=0, height=1)
    with pytest.raises(ValidationError):
        BoundingBox.model_validate({"x": 0, "y": 0, "width": 1, "height": 1, "z": 1})


def test_skew_one_decimal():
    r = VisionResult(image_width=1, image_height=1, skew_angle_degrees=1.234, engine="tesseract", cells=[], defects=[])
    assert r.skew_angle_degrees == 1.2


@pytest.mark.parametrize("q", ["", "   ", "x" * 501, " " + "x" * 500])
def test_search_query_bounds_rejected(q):
    with pytest.raises(ValidationError):
        SearchRequest(query=q)


def test_search_query_stripped():
    assert SearchRequest(query="  hi ").query == "hi"


def test_payload_model_lookup_rejects_inconsistent_events():
    with pytest.raises(ValueError):
        payload_model("terminal", "rot_detector", None)
    with pytest.raises(ValueError):
        payload_model("node", "nope", "started")
