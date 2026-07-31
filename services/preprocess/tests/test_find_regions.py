import numpy as np

from preprocess_service.retrieval import _interior_mask, _select_candidates


def _grid(side, step):
    """A dense square patch grid of `side`×`side` cells at `step` px, as a coords [N,2] array."""
    xs = [i * step for i in range(side)]
    return np.array([[x, y] for y in xs for x in xs], dtype=np.int64)


def test_select_candidates_caps_edge_dominated_top_k():
    # Edge patches carry the highest raw similarity (the CONCH artifact) — make the whole
    # boundary rank above the interior, then assert selection still forces interior foci in.
    step = 10
    coords = _grid(6, step)  # 36 patches; inner 4×4 = 16 interior, 20 on the perimeter
    interior = _interior_mask(coords, step)
    sims = np.where(interior, 0.1, 0.9).astype(np.float32)  # every edge patch beats every interior
    sims += np.arange(len(coords), dtype=np.float32) * 1e-4  # break ties deterministically
    k = 8
    picks = _select_candidates(coords, sims, k, ps0=step)
    assert len(picks) == k
    scores = [float(sims[i]) for i in picks]
    assert scores == sorted(scores, reverse=True)  # returned in similarity order
    n_edge = sum(1 for i in picks if not interior[i])
    assert n_edge <= (k // 2)  # edge patches capped even though they dominate the raw ranking
    # spatially distinct: no two picks share the same or an adjacent cell on both axes
    for a in range(len(picks)):
        for b in range(a + 1, len(picks)):
            ia, ib = picks[a], picks[b]
            dx = abs(int(coords[ia][0]) - int(coords[ib][0]))
            dy = abs(int(coords[ia][1]) - int(coords[ib][1]))
            assert dx >= 2 * step or dy >= 2 * step


def test_select_candidates_tops_up_to_k_when_pruning_falls_short():
    # A tiny grid where NMS + the edge cap cannot yield k distinct interior foci: tier-2 must
    # still return exactly k (the model asked for k leads), never silently fewer.
    coords = _grid(3, 10)  # 9 patches, only 1 interior → cap/NMS alone can't reach k
    sims = np.arange(9, dtype=np.float32)
    picks = _select_candidates(coords, sims, k=6, ps0=10)
    assert len(picks) == 6 and len(set(picks)) == 6


def _build_index(client, wait, item="slide1", encoder="conch_v1_text"):
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
    item = _build_index(client, wait)  # conch_v1_text == text_encoder default → params_hash matches
    r = client.post("/find_regions", json={"item": item, "query": "invasive tumor", "k": 5})
    assert r.status_code == 200
    b = r.get_json()
    assert b["encoder"] == "conch_v1_text" and b["n_candidates"] == 5
    assert b["query"] == "invasive tumor"
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
