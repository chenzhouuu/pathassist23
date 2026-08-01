def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    b = r.get_json()
    assert b["service"] == "preprocess" and b["model"] == "stub"


def test_run_requires_item(client):
    assert client.post("/run", json={}).status_code == 400


def test_run_enqueues_and_completes(client, wait):
    r = client.post("/run", json={"item": "item1", "encoder": "conch_v1"})
    assert r.status_code == 202
    b = r.get_json()
    assert b["status"] == "queued" and b["encoder"] == "conch_v1"
    assert len(b["params_hash"]) == 16 and b["mag"] == 20 and b["patch_size"] == 256

    done = wait(client, b["job_id"], "ready")
    assert done["status"] == "ready"
    assert done["n_patches"] == 16 and done["encoder"] == "conch_v1"
    assert done["params_hash"] == b["params_hash"] and done["progress"] == 1.0


def test_status_requires_job_id(client):
    assert client.get("/status").status_code == 400


def test_status_unknown_is_404(client):
    assert client.get("/status?job_id=nope").status_code == 404


def test_resolver_failure_marks_job_failed(client, wait):
    def boom(item, dest, settings, token):
        raise RuntimeError("no slide on this Girder")

    client.application.config["RESOLVE"] = boom
    b = client.post("/run", json={"item": "x"}).get_json()
    done = wait(client, b["job_id"], "failed")
    assert done["status"] == "failed" and "no slide" in done["error"]


# ── DAG stage endpoints (Inc 2b-3) ──────────────────────────────────────────────────


def _segment(client, wait, item="slideA"):
    b = client.post("/segment", json={"item": item, "segmenter": "hest"}).get_json()
    assert b["kind"] == "segmentation" and len(b["seg_hash"]) == 16
    done = wait(client, b["job_id"], "ready")
    assert done["n_contours"] == 1
    return b["seg_hash"]


def _patch(client, wait, item, seg_hash, mag=20, patch_size=256):
    b = client.post("/patch", json={
        "item": item, "seg_hash": seg_hash, "mag": mag, "patch_size": patch_size,
    }).get_json()
    assert b["kind"] == "patching" and len(b["patch_hash"]) == 16
    done = wait(client, b["job_id"], "ready")
    return b["patch_hash"], done


def test_segment_enqueues_and_completes(client, wait):
    _segment(client, wait)


def test_patch_requires_item_and_seg_hash(client):
    assert client.post("/patch", json={"item": "s"}).status_code == 400
    assert client.post("/patch", json={"seg_hash": "abc"}).status_code == 400


def test_patch_before_segment_is_409(client):
    r = client.post("/patch", json={"item": "s", "seg_hash": "notbuilt0000000"})
    assert r.status_code == 409 and "segment this slide first" in r.get_json()["detail"]


def test_features_before_patch_is_409(client):
    r = client.post("/features", json={"item": "s", "patch_hash": "notbuilt0000000"})
    assert r.status_code == 409 and "tile this slide first" in r.get_json()["detail"]


def test_dag_chain_segment_patch_features(client, wait):
    item = "slideChain"
    sh = _segment(client, wait, item)
    ph, patch_done = _patch(client, wait, item, sh)
    assert patch_done["n_patches"] == 64  # 4096-px square, ps0=512 → 8×8

    b = client.post("/features", json={
        "item": item, "patch_hash": ph, "encoder": "conch_v1",
    }).get_json()
    assert b["kind"] == "features" and len(b["feat_hash"]) == 16 and b["patch_hash"] == ph
    done = wait(client, b["job_id"], "ready")
    assert done["n_patches"] == 64 and done["dim"] == 16 and done["encoder"] == "conch_v1"


def test_patch_grid_reused_across_encoders(client, wait):
    # Same seg + same tiling → same patch_hash for two feature builds (reuse).
    item = "slideReuse"
    sh = _segment(client, wait, item)
    ph_a, _ = _patch(client, wait, item, sh)
    ph_b, _ = _patch(client, wait, item, sh)
    assert ph_a == ph_b


def test_run_all_completes_and_returns_three_hashes(client, wait):
    b = client.post("/run_all", json={"item": "slideAll", "encoder": "conch_v1"}).get_json()
    assert b["status"] == "queued" and b["kind"] == "run_all"
    for key in ("seg_hash", "patch_hash", "feat_hash"):
        assert len(b[key]) == 16
    done = wait(client, b["job_id"], "ready")
    assert done["n_patches"] == 64 and done["dim"] == 16
    assert done["feat_hash"] == b["feat_hash"]


def test_run_all_stages_reported_in_order(client, wait):
    b = client.post("/run_all", json={"item": "slideOrder"}).get_json()
    done = wait(client, b["job_id"], "ready")
    assert done["stage"] == "done" and done["progress"] == 1.0


def test_contours_served_after_segment(client, wait):
    item = "slideContours"
    sh = _segment(client, wait, item)
    r = client.get(f"/contours?item={item}&seg_hash={sh}")
    assert r.status_code == 200
    gj = r.get_json()
    assert gj["type"] == "FeatureCollection"
    assert gj["features"][0]["geometry"]["type"] == "Polygon"


def test_contours_unknown_seg_hash_is_404(client):
    r = client.get("/contours?item=s&seg_hash=notbuilt0000000")
    assert r.status_code == 404


def test_contours_requires_item_and_seg_hash(client):
    assert client.get("/contours?item=s").status_code == 400


def test_find_regions_via_feat_hash(client, wait):
    b = client.post("/run_all", json={"item": "slideFR", "encoder": "conch_v1_text"}).get_json()
    wait(client, b["job_id"], "ready")
    r = client.post("/find_regions", json={
        "item": "slideFR", "query": "invasive tumor", "feat_hash": b["feat_hash"], "k": 5,
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["n_candidates"] == 5 and body["encoder"] == "conch_v1_text"


# ── POST /hash — the content address, without doing the work (Inc 6, ticket 01) ──────────


def test_hash_matches_what_the_run_would_produce(client):
    """The point of the endpoint: the gateway can name the artifact before dispatching it.

    From Inc 6 the run goes onto a Celery queue and the gateway never sees the service's ack, so
    this equality is what lets it write the row at submit time.
    """
    params = {"segmenter": "hest", "seg_conf_thresh": 0.4, "remove_holes": True}
    pre = client.post("/hash", json={"kind": "segmentation", **params})
    assert pre.status_code == 200
    run = client.post("/segment", json={"item": "item1", **params})
    assert run.status_code == 202
    assert pre.get_json()["art_hash"] == run.get_json()["seg_hash"]


def test_hash_enqueues_nothing(client):
    """Pure. Asking twice must not leave two jobs behind."""
    before = client.post("/hash", json={"kind": "segmentation"}).get_json()
    after = client.post("/hash", json={"kind": "segmentation"}).get_json()
    assert before["art_hash"] == after["art_hash"]
    assert client.get("/status", query_string={"job_id": "any"}).status_code == 404


def test_hash_resolves_defaults_the_same_way_a_run_does(client):
    """An empty body is the default build, not an error — the same params /segment would fill in."""
    body = client.post("/hash", json={"kind": "segmentation"}).get_json()
    assert len(body["art_hash"]) == 16
    assert body["params"]["segmenter"]
    assert body["params"]["seg_conf_thresh"] == 0.5


def test_child_kinds_hash_against_their_parent(client):
    patch = client.post("/hash", json={"kind": "patching", "seg_hash": "abc", "mag": 20})
    assert patch.status_code == 200
    assert patch.get_json()["parent_hash"] == "abc"

    other_parent = client.post("/hash", json={"kind": "patching", "seg_hash": "def", "mag": 20})
    assert other_parent.get_json()["art_hash"] != patch.get_json()["art_hash"], (
        "a patch grid's address must depend on the segmentation it was cut from"
    )

    feat = client.post("/hash", json={"kind": "features", "patch_hash": "abc",
                                      "encoder": "conch_v1"})
    assert feat.status_code == 200 and feat.get_json()["parent_hash"] == "abc"


def test_a_child_kind_without_its_parent_is_refused(client):
    assert client.post("/hash", json={"kind": "patching"}).status_code == 400
    assert client.post("/hash", json={"kind": "features"}).status_code == 400


def test_an_unknown_kind_is_refused_rather_than_guessed(client):
    r = client.post("/hash", json={"kind": "nuclei"})
    assert r.status_code == 400
    assert "nuclei" in r.get_json()["detail"]
