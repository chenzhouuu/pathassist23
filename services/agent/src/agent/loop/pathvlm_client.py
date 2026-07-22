"""Gateway → pathvlm Perceptor service HTTP client (Inc 2a).

The ``describe_region`` server tool calls this to get a morphology description of a region from
the pathvlm service (MedGemma). The Girder token is sent server-to-server and is never a model
argument (D3). Mirrors ``segmenter.py``.
"""

from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class DescribeResult:
    """A Perceptor description of a region + the objective power it was actually seen at."""

    description: str
    magnification: float | None = None
    mpp: float | None = None


async def describe_region(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    magnification: int | None,
    focus: str | None,
    token: str | None,
    timeout: float = 120.0,
    client: httpx.AsyncClient | None = None,
) -> DescribeResult:
    """POST the ROI to the pathvlm service; return its description + the magnification used."""
    payload = {
        "slide_ref": slide_ref,
        "bbox": bbox,
        "magnification": magnification,
        "focus": focus,
        "girder_token": token,
    }
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/describe_region", json=payload)
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            await client.aclose()
    mag = data.get("magnification_used")
    mpp = data.get("mpp")
    return DescribeResult(
        description=str(data.get("description", "")),
        magnification=float(mag) if mag is not None else None,
        mpp=float(mpp) if mpp is not None else None,
    )
