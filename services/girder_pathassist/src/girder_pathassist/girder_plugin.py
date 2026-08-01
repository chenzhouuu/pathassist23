"""Girder-side plugin entry point.

Loads the `worker` plugin first, the way `slicer_cli_web` does: without it `.delay()` publishes to
the broker but no Girder job is created, so a dispatch would run and be invisible. Failing loudly
here is better than a Runs list that is quietly always empty.
"""

import logging

from girder.plugin import GirderPlugin, getPlugin

from .rest import PathAssistResource

logger = logging.getLogger(__name__)


class PathAssistPlugin(GirderPlugin):
    DISPLAY_NAME = "PathAssist"

    def load(self, info):
        # The worker plugin is what installs girder_worker's before_task_publish hook, which is
        # what turns a dispatch into a Girder job. Loading it explicitly means the dependency is
        # stated rather than assumed from plugin load order.
        getPlugin("worker").load(info)

        # The attribute name must match `resourceName`, or the routes mount at the wrong path.
        info["apiRoot"].pathassist = PathAssistResource("pathassist")
        logger.info("PathAssist job dispatch mounted at /pathassist/run")
