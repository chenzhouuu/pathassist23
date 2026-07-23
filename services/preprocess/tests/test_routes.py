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
