"""Tool registry (PathAgent v2, increment 4).

Registry-as-data — the TissueLab pattern — but with a *real* JSON Schema per tool
(`consumes.args`) and typed artifact edges (`consumes.artifacts` / `produces.artifacts`)
so a plan can be statically validated before a human ever approves it. The catalog is
rendered into the planner prompt, and the tool names become an enum the planner is
constrained to (see `chat`/`plan.planner`).

At increment 4 the tools are canned-output stubs; increments 7–8 swap in CellViT++ and
Histolytics behind the identical contract, and the registry is where they register.
"""

import hashlib
import json
from functools import lru_cache
from pathlib import Path

_TOOLS_PATH = Path(__file__).with_name("tools.json")


class Registry:
    """A loaded, immutable view of the tool catalog."""

    def __init__(self, tools: list[dict]) -> None:
        self._tools = {t["name"]: t for t in tools}
        # A content hash of the catalog; part of the plan digest so a registry change
        # invalidates previously-approved plans (they must be re-planned + re-approved).
        canon = json.dumps(tools, sort_keys=True, separators=(",", ":"))
        self.version = hashlib.sha256(canon.encode()).hexdigest()[:12]

    def names(self) -> list[str]:
        """Tool names — the enum the planner is constrained to."""
        return list(self._tools)

    def get(self, name: str) -> dict | None:
        return self._tools.get(name)

    def public(self) -> list[dict]:
        """The catalog as served by GET /tools (already JSON-ready)."""
        return list(self._tools.values())

    def catalog_text(self) -> str:
        """Render the catalog for the planner prompt.

        Crucially separates ARTIFACTS (auto-supplied dependency edges — never args) from
        ARGS (the exact tuning parameters the planner must fill), so the model does not
        stuff `slide_ref`/`roi`/`nuclei` into a step's args.
        """
        lines = []
        for t in self._tools.values():
            arts_in = ", ".join(t["consumes"].get("artifacts", [])) or "—"
            arts_out = ", ".join(t["produces"].get("artifacts", [])) or "—"
            schema = t["consumes"].get("args") or {}
            props = schema.get("properties", {})
            required = set(schema.get("required", []))
            if props:
                args_desc = "; ".join(
                    f"{k}:{spec.get('type', 'any')} "
                    f"({'required' if k in required else 'optional'})"
                    for k, spec in props.items()
                )
            else:
                args_desc = "none"
            lines.append(
                f"- {t['name']} [{t['category']}]: {t['description']}\n"
                f"    inputs (artifacts, auto-supplied): {arts_in}\n"
                f"    outputs (artifacts): {arts_out}\n"
                f"    args (provide EXACTLY these, nothing else): {args_desc}"
            )
        return "\n".join(lines)


@lru_cache
def load_registry() -> Registry:
    data = json.loads(_TOOLS_PATH.read_text(encoding="utf-8"))
    return Registry(data["tools"])
