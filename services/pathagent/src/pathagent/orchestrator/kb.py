"""Seed knowledge-base loader for the PathAgent M3 orchestrator.

Task 3 only needs to load the bundled starter facts; scoring and citation
helpers are added in Task 4.
"""

import json
from pathlib import Path

_SEED_KB_PATH = Path(__file__).parent / "seed_kb.json"


def load_seed_kb() -> list[dict]:
    """Load the bundled seed knowledge-base entries.

    Returns:
        A list of ``{"id", "text", "source"}`` dicts parsed from
        ``seed_kb.json`` next to this module.
    """
    return json.loads(_SEED_KB_PATH.read_text())
