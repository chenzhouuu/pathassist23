import httpx

from biomarker_service.cellvit_client import fetch_centroids


def _mock_client(body, capture):
    def handler(request: httpx.Request) -> httpx.Response:
        capture["path"] = request.url.path
        capture["json"] = __import__("json").loads(request.content)
        return httpx.Response(200, json=body)

    return httpx.Client(transport=httpx.MockTransport(handler), base_url="http://cellvit:8020")


def test_fetch_centroids_maps_level0_and_class_names():
    capture = {}
    body = {
        "count": 2,
        "centroids": [[100.0, 200.0], [110.0, 220.0]],
        "classes": [1, 2],
        "class_names": {"1": "Neoplastic", "2": "Inflammatory"},
        "mpp": 0.5,
    }
    client = _mock_client(body, capture)
    res = fetch_centroids(
        base_url="http://cellvit:8020", slide_ref="item1",
        bbox={"x": 100, "y": 200, "width": 64, "height": 48}, token="tok", client=client,
    )
    assert capture["path"] == "/segment"
    assert capture["json"]["girder_token"] == "tok"
    assert res.centroids == [[100.0, 200.0], [110.0, 220.0]]
    assert res.classes == ["Neoplastic", "Inflammatory"]
    assert res.mpp == 0.5


def test_fetch_centroids_degrades_without_class_names():
    client = _mock_client({"count": 1, "centroids": [[1.0, 2.0]]}, {})
    res = fetch_centroids(
        base_url="http://cellvit:8020", slide_ref="s",
        bbox={"x": 0, "y": 0, "width": 8, "height": 8}, token=None, client=client,
    )
    assert res.centroids == [[1.0, 2.0]]
    assert res.classes == []  # no class_names on the wire → empty, centroids still usable
