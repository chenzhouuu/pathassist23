# job-trace — watch one analysis run cross the whole stack

```bash
python3 scripts/job_trace/serve.py     # then open http://127.0.0.1:8099/
```

Stdlib only. No build step, no dependency on `npm run dev`.

## What it is for

A run submitted from the Analysis panel crosses six processes before a pixel comes back —
browser, gateway, Girder, RabbitMQ, the Celery driver, the GPU service. Each is observable from a
different place, and a *successful* Girder job writes no log at all, so "it is at 42%" is the whole
of what the product can tell you about where a run is.

This page submits the same calls the Analysis panel submits, and narrates all eleven hops as the
evidence for each arrives: the real request and response bodies, the planner's own answer, the
Girder job's status transitions, the three containers' stdout, the artifact row before and after,
and finally the tiles themselves drawn over the H&E.

It also answers the question the panel is worst at: **you drew a rectangle, and the run computed
something bigger.** The map shows both in the same coordinate system — your box in red, the 2048 px
core tiles the run actually covers in blue — with the ratio spelled out before you commit to it.

## What it is not

The sidecar adds nothing the page did not ask for: it forwards the page's calls verbatim and tails
container stdout, originates no request of its own, and no production code knows it exists. The
page itself does dispatch real runs — that is what it is for, and a region run costs real GPU. It
holds no credentials; the page signs in for itself and keeps its token in `sessionStorage`.

It binds `127.0.0.1` and is not meant to be exposed.

## Configuration

| env | default | what |
|---|---|---|
| `JOB_TRACE_PORT` | `8099` | listen port |
| `JOB_TRACE_HOST` | `127.0.0.1` | listen address |
| `JOB_TRACE_GIRDER_BASE` | `http://localhost:9080/api/v1` | this box's Girder |
| `JOB_TRACE_COPILOT_BASE` | `http://localhost:8010/api/copilot` | this box's gateway |
| `JOB_TRACE_CONTAINERS` | `agent-copilot-1,agent-celery-1,agent-cellvit-1` | whose stdout to stream |

Docker is optional. Without it the log panel says so and the rest still works; the two hops that
are only visible in container stdout say they had nothing to show rather than claiming they saw
something.

## The eleven hops

| | hop | where to read it |
|---|---|---|
| 0 | 登录，换 token | `runner.service_payload` |
| 1 | 表单 → `startNuclei()` | `nativeCatalog.js`, `nucleiApi.js` |
| 2 | `POST /slides/{item}/nuclei` | `gateway/routes.py::start_nuclei` |
| 3 | gateway 规划 | `gateway/plan.py::missing`, `GROWABLE_KINDS` |
| 4 | `POST /pathassist/chain` | `gateway/routes.py::_plan_and_dispatch` |
| 5 | Girder 建 Celery chain | `girder_pathassist/rest.py::runChain` |
| 6 | worker 起 job | `girder_worker_plugin/driver.py::run_analysis` |
| 7 | driver 轮询服务 | `runner.py::submit` / `read_status` |
| 8 | 服务逐核心瓦片算 | `cellvit_service/routes.py` |
| 9 | 回报，写行 | `runner.py::report_terminal` |
| 10 | 前端合并，出图 | `workspace/runJoin.js::joinRuns` |

Each hop carries its own "why this is like this" in the page, next to the bytes that prove it.
