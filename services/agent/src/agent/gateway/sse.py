import json
from typing import Any


def sse_json(data: dict[str, Any]) -> dict[str, str]:
    """Format a dict as an sse-starlette event payload (JSON in the `data:` field).

    The frontend splits frames on a blank line and JSON-parses each `data:` line
    (see src/api/copilotApi.js), so keep every event a single compact JSON object.
    """
    return {"data": json.dumps(data, separators=(",", ":"))}
