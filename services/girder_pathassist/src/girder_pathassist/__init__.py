"""The Celery bridge for PathAssist analysis jobs (Inc 6 · ticket 01).

Everything a PathAssist analysis run needs that is *not* the analysis: a Girder job to record it,
a Celery queue to serialise it, and a driver that watches the service actually doing the work.

The split across this package mirrors `slicer_cli_web`:

- `girder_plugin.py` / `rest.py` run **inside the Girder process**. That is not a preference — it
  is where `girder_worker.context.girder_context.create_task_job` can reach `getCurrentUser()` and
  the model layer, which is what mints the job, the `jobInfoSpec` and the scoped token.
- `girder_worker_plugin/` runs **inside the Celery worker**. It holds one task, and that task
  computes nothing: it drives the box-local analysis service over its existing HTTP surface and
  mirrors what it reads back into the Girder job.

The models stay in the services (Inc 6 · D4). A worker that loaded CellViT itself would give up
the warm weights, the warm-up and the idle GPU release that three increments went into.
"""

#: Kinds this bridge can dispatch. A kind not in here is refused at the REST layer rather than
#: discovered as a missing env var an hour into a queue.
KINDS = ("segmentation", "patching", "features", "prediction", "nuclei", "tissue", "biomarker")

__all__ = ["KINDS"]
