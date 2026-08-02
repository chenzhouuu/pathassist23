"""The three tables that describe an analysis kind, held against each other.

`KINDS` gates the REST layer, `ROUTES` says where a kind is dispatched, and `TITLES` names it in
the Runs list. They live apart because they are read in different processes — which is exactly why
nothing but a test notices when a new kind is added to one and not the others. Inc 7 shipped
`classify` in `ROUTES` alone, and the gap surfaced as a 400 in a browser rather than here.
"""

from girder_pathassist import KINDS, TITLES
from girder_pathassist.routing import ROUTES


def test_every_dispatchable_kind_has_an_address():
    assert set(KINDS) == set(ROUTES)


def test_every_dispatchable_kind_has_a_title():
    assert set(KINDS) == set(TITLES)


def test_no_kind_is_named_twice():
    assert len(KINDS) == len(set(KINDS))
