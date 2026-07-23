def _build_index(client, wait, item="slide1", encoder="conch_v1"):
    b = client.post("/run", json={"item": item, "encoder": encoder}).get_json()
    wait(client, b["job_id"], "ready")
    return item


def test_find_regions_requires_item_and_query(client):
    assert client.post("/find_regions", json={"item": "s"}).status_code == 400
    assert client.post("/find_regions", json={"query": "tumor"}).status_code == 400


def test_find_regions_not_indexed_is_404(client):
    r = client.post("/find_regions", json={"item": "never-built", "query": "tumor"})
    assert r.status_code == 404
    assert "text search" in r.get_json()["detail"]


def test_find_regions_image_only_encoder_is_409(client):
    r = client.post("/find_regions", json={
        "item": "s", "query": "tumor", "encoder": "conch_v15",
    })
    assert r.status_code == 409
    assert "image-only" in r.get_json()["detail"]


def test_find_regions_returns_ranked_level0_boxes(client, wait):
    item = _build_index(client, wait)  # conch_v1 == text_encoder default → params_hash matches
    r = client.post("/find_regions", json={"item": item, "query": "invasive tumor", "k": 5})
    assert r.status_code == 200
    b = r.get_json()
    assert b["encoder"] == "conch_v1" and b["n_candidates"] == 5 and b["query"] == "invasive tumor"
    regions = b["regions"]
    # level-0 boxes with a fixed patch side (mag 20 on native-40 stub → 512)
    assert all(rg["width"] == 512 and rg["height"] == 512 for rg in regions)
    scores = [rg["score"] for rg in regions]
    assert scores == sorted(scores, reverse=True) and b["top_score"] == scores[0]


def test_find_regions_is_query_sensitive(client, wait):
    item = _build_index(client, wait)
    a = client.post("/find_regions", json={"item": item, "query": "necrosis", "k": 8}).get_json()
    c = client.post("/find_regions", json={"item": item, "query": "stroma", "k": 8}).get_json()
    # different queries generally rank the patches differently (deterministic per query)
    assert [r["score"] for r in a["regions"]] != [r["score"] for r in c["regions"]]
