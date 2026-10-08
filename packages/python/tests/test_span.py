from atlas_ml.encoder import parse_span, split_span_ref


def test_split_span_ref():
    assert split_span_ref("/videos/x.mp4#t=12.0,16.0") == ("/videos/x.mp4", 12.0, 16.0)
    assert split_span_ref("http://h/a.mp4#t=0.000,4.000") == ("http://h/a.mp4", 0.0, 4.0)
    assert split_span_ref("/frames/frame_00001.jpg") is None
    assert split_span_ref("x.mp4#t=1.0") is None
    assert split_span_ref("x.mp4#t=a,b") is None
    assert split_span_ref("x.mp4#t=4.0,2.0") is None


def test_parse_span_accepts_wire_shapes():
    assert parse_span({"start": 1, "end": 2.5}) == (1.0, 2.5)
    assert parse_span([1, 2]) == (1.0, 2.0)
    assert parse_span(None) is None
    assert parse_span({"start": 3, "end": 1}) is None
    assert parse_span({"start": "x", "end": 1}) is None
    assert parse_span({"end": 1}) is None
