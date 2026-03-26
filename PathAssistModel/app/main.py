from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from celery.result import AsyncResult
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.annotation_service import elements_to_annotation_docs, hovernet_to_elements, load_hovernet_output
from app.config import get_settings
from app.girder_service import GirderService
from app.inference_service import InferenceService
from app.utils import job_dir, managed_workdir, setup_logging
from worker.celery_worker import celery_app
from worker.tasks import process_wsi_item


settings = get_settings()
setup_logging(settings.log_level)
app = FastAPI(title=settings.app_name, version="1.0.0")


class WSIInferenceRequest(BaseModel):
    item_id: str = Field(..., description="Girder item id for the whole-slide image")
    sync: bool = Field(default=False, description="Run inference inline instead of dispatching to Celery")


class AnnotationSummary(BaseModel):
    annotation_ids: List[str]
    nuclei_count: int
    result_artifact: Optional[str] = None


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    return {"status": "ok", "service": settings.app_name, "env": settings.env}


def _run_sync(item_id: str) -> Dict[str, Any]:
    girder = GirderService(settings)
    inference = InferenceService(settings)
    item = girder.get_item(item_id)
    with managed_workdir(job_dir(settings.output_root, "sync"), keep=settings.keep_workdir) as workdir:
        slide_path = girder.download_item_file(item_id, workdir / "input")
        infer_result = inference.run_hovernet(slide_path, workdir / "output")
        instances = load_hovernet_output(Path(infer_result["output_path"]))
        elements = hovernet_to_elements(instances, settings)
        annotation_docs = elements_to_annotation_docs(item["name"], elements, settings)
        annotation_ids = [
            girder.create_annotation(item_id, {"annotation": doc})["_id"]
            for doc in annotation_docs
        ]
        return {
            "item_id": item_id,
            "item_name": item["name"],
            "nuclei_count": len(elements),
            "annotation_ids": annotation_ids,
            "output_path": infer_result["output_path"],
        }


@app.post("/v1/jobs/hovernet")
def submit_hovernet_job(request: WSIInferenceRequest) -> Dict[str, Any]:
    if request.sync:
        return _run_sync(request.item_id)
    task = process_wsi_item.delay(request.item_id)
    return {"task_id": task.id, "status": "queued", "item_id": request.item_id}


@app.get("/v1/jobs/{task_id}")
def get_job_status(task_id: str) -> Dict[str, Any]:
    result = AsyncResult(task_id, app=celery_app)
    response: Dict[str, Any] = {"task_id": task_id, "status": result.status}
    if result.successful():
        response["result"] = result.result
    elif result.failed():
        response["error"] = str(result.result)
    return response


@app.post("/v1/jobs/{task_id}/cancel")
def cancel_job(task_id: str) -> Dict[str, Any]:
    celery_app.control.revoke(task_id, terminate=True)
    return {"task_id": task_id, "status": "revoked"}
