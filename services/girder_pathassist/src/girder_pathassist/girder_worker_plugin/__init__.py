"""Worker-side registration: tells girder_worker which module holds our task.

Same shape as `slicer_cli_web/girder_worker_plugin/__init__.py`. `task_imports` is what the worker
walks at startup to find `@app.task`-decorated functions; without it the task exists in the package
but the worker never registers it and every dispatch dead-letters.
"""

from girder_worker import GirderWorkerPluginABC


class PathAssistWorkerPlugin(GirderWorkerPluginABC):
    def __init__(self, app, *args, **kwargs):
        self.app = app

    def task_imports(self):
        return ["girder_pathassist.girder_worker_plugin.driver"]
