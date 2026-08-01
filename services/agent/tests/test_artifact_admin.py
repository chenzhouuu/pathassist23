"""Where the gateway looks for an artifact's bytes (Inc 5, ticket 04).

This is the one part of delete that the route tests cannot see: they double out the client, so a
wrong URL still "reaches the worker". It went wrong exactly there — `nuclei` fell into the
preprocess branch and the gateway asked cellvit for `/artifacts/nuclei/...`, which is a 404. Usage
silently reported 0 bytes (it is only decoration, so it swallows errors), and a delete removed the
durable row and left the directory on disk. Caught by asking a running gateway for the size of a
90 MB artifact and getting 0.

So each entry below is pinned against the route its service actually registers.
"""

import pytest

from agent.loop.artifact_admin import _path

# kind -> the path its owning service serves, verbatim from that service's routes.py.
#   tissue      @app.get("/tissue/<item>/<ahash>/usage")        tissue_service/routes.py
#   biomarker   @app.get("/biomarker/<item>/<ahash>/usage")     biomarker_service/routes.py
#   nuclei      @app.get("/nuclei/<item>/<ahash>/usage")        cellvit_service/routes.py
#   the rest    /artifacts/<kind>/<item>/<ahash>                preprocess owns four kinds, so it
#                                                               is told which one and maps it
OWNED = {
    "tissue": "/tissue/i1/h1",
    "biomarker": "/biomarker/i1/h1",
    "nuclei": "/nuclei/i1/h1",
    "segmentation": "/artifacts/segmentation/i1/h1",
    "patching": "/artifacts/patching/i1/h1",
    "features": "/artifacts/features/i1/h1",
    "prediction": "/artifacts/prediction/i1/h1",
}


@pytest.mark.parametrize(("kind", "expected"), sorted(OWNED.items()))
def test_each_kind_is_asked_for_at_the_path_its_service_serves(kind, expected):
    assert _path(kind, "i1", "h1") == expected


def test_a_service_that_owns_one_kind_names_it_in_the_path():
    """The distinction the table encodes: a single-kind service has the kind in its URL already,
    a multi-kind one has to be told. Getting a new kind's side wrong is a 404 the usage path
    swallows, so it is worth stating as its own claim."""
    single = {k for k, v in OWNED.items() if not v.startswith("/artifacts/")}
    assert single == {"tissue", "biomarker", "nuclei"}


def test_an_unknown_kind_goes_to_preprocess_rather_than_nowhere():
    """New preprocess stages should work without touching this table; a genuinely new *service*
    will fail loudly at its 404 instead of being silently mis-addressed here."""
    assert _path("something_new", "i1", "h1") == "/artifacts/something_new/i1/h1"
