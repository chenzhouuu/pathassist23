"""Resolve every existing nuclei artifact row against the disk (Inc 6 · 05).

Nuclei is the first kind to move to the D9 shape: **a row exists ⟺ bytes exist on disk**. Rows
written under the old shape do not obey that — the gateway wrote one at submit and then advanced it
only while somebody had that slide's Workspace open, so a worker restart mid-run left rows sitting
at `running` for good. There is no third case to decide and no state to repair: ask the cellvit
service what the artifact costs on disk, keep the row if the answer is more than nothing, delete it
if it is not.

Run once, from inside the gateway container — that is where both the database and the cellvit
service are reachable, and where the two env vars are already set:

    docker cp services/agent/scripts/migrate_nuclei_rows.py agent-copilot-1:/tmp/
    docker exec agent-copilot-1 /app/.venv/bin/python /tmp/migrate_nuclei_rows.py          # report
    docker exec agent-copilot-1 /app/.venv/bin/python /tmp/migrate_nuclei_rows.py --apply  # delete

Reads the gateway's own two settings (`AGENT_DATABASE_URL`, `AGENT_CELLVIT_SERVICE_URL`), so it
cannot be pointed at a different database than the one it is repairing.

Deliberately a report by default: deleting a row is deleting the only record that an artifact was
ever built, and the counts are worth reading before that happens.
"""

import argparse
import asyncio
import os
import sys

import asyncpg
import httpx

DSN = os.environ.get("AGENT_DATABASE_URL", "postgresql://copilot:copilot@db:5432/copilot")
CELLVIT = os.environ.get("AGENT_CELLVIT_SERVICE_URL", "http://cellvit:8020")


async def artifact_bytes(client: httpx.AsyncClient, item: str, art_hash: str) -> int | None:
    """Bytes this artifact occupies, or None when the service could not answer.

    None is not zero. A service that is down must not cause a row to be deleted — the bytes are
    still there and the row is still true; this run simply cannot tell.
    """
    try:
        resp = await client.get(f"/nuclei/{item}/{art_hash}/usage")
        resp.raise_for_status()
        return int((resp.json() or {}).get("bytes") or 0)
    except (httpx.HTTPError, ValueError, TypeError):
        return None


async def main(apply: bool) -> int:
    pool = await asyncpg.create_pool(DSN, min_size=1, max_size=2)
    rows = await pool.fetch(
        "SELECT girder_item, art_hash, status, created_at FROM preprocess_artifact "
        "WHERE kind = 'nuclei' ORDER BY created_at",
    )
    kept, dropped, unknown = [], [], []

    async with httpx.AsyncClient(base_url=CELLVIT, timeout=30.0) as client:
        for r in rows:
            n = await artifact_bytes(client, r["girder_item"], r["art_hash"])
            bucket = unknown if n is None else (kept if n > 0 else dropped)
            bucket.append((r["girder_item"], r["art_hash"], r["status"], n))

    for item, art, status, n in kept:
        print(f"keep   {item} {art} was={status:<10} {n:>12,} bytes")
    for item, art, status, _ in dropped:
        print(f"delete {item} {art} was={status:<10}   nothing on disk")
    for item, art, status, _ in unknown:
        print(f"skip   {item} {art} was={status:<10}   cellvit did not answer")

    if apply and dropped:
        await pool.executemany(
            "DELETE FROM preprocess_artifact WHERE girder_item = $1 AND art_hash = $2",
            [(item, art) for item, art, _, _ in dropped],
        )

    print(f"\n{len(rows)} nuclei rows · {len(kept)} kept · "
          f"{len(dropped)} {'deleted' if apply and dropped else 'to delete'} · "
          f"{len(unknown)} unresolved")
    if dropped and not apply:
        print("re-run with --apply to delete them")
    await pool.close()
    return 1 if unknown else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="delete the rows with no bytes behind them")
    sys.exit(asyncio.run(main(ap.parse_args().apply)))
