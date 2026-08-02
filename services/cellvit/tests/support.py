"""Helpers the service tests share.

`Segmented` grew from a three-tuple to five named arrays in Inc 7, and every test that fakes the
model has to produce one. Built here so the fake in each file stays about what that file is
testing — which nuclei, where — rather than about the shape of the seam.
"""

import numpy as np

from cellvit_service.artifacts import TOKEN_DIM
from cellvit_service.infer import Segmented


def segmented(points, classes, contours, *, probs=None, tokens=None):
    """A `Segmented` from the three arrays a test usually cares about.

    Tokens default to zeros: a test that is not about classification should not have to invent an
    embedding, and a zero one is unmistakably not a claim about anything.
    """
    n = len(points)
    return Segmented(
        points=points,
        classes=classes,
        contours=contours,
        tokens=(np.zeros((n, TOKEN_DIM), dtype=np.float16) if tokens is None
                else np.asarray(tokens, dtype=np.float16).reshape(n, TOKEN_DIM)),
        probs=[1.0] * n if probs is None else list(probs),
    )
