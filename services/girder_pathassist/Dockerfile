# The Celery worker that drives analysis runs (Inc 6 · ticket 01).
#
# Based on the DSA image because that is where `girder_worker` already lives, and because the
# driver has to speak the same Celery protocol and job-header format as `dsa-worker-1`. It is a
# heavy base for a package this small, but it is already on every box that runs the stack, and a
# second Celery implementation talking to the same broker is exactly the divergence this increment
# exists to remove.
#
# Nothing GPU here on purpose. This container holds no model, opens no slide and imports no torch:
# it POSTs to the box-local analysis services and mirrors their progress into a Girder job
# (plan D4). That is why one worker slot can be held for hours without costing anything.
FROM dsarchive/dsa_common_5

COPY services/girder_pathassist /opt/girder_pathassist
RUN /opt/venv/bin/pip install --no-cache-dir -e /opt/girder_pathassist

# `-Q` names this box. The queue name *is* the placement decision (Inc 6 · D6): a second GPU box
# runs this same image with a different PATHASSIST_QUEUE, and rabbitmq does the routing.
# `--concurrency=1` is the serialisation — one analysis at a time per box, never an OOM.
ENV PATHASSIST_QUEUE=pathassist

# Celery refuses to start as root without this, and the DSA base image has no non-root user.
# The same setting is already on dsa-girder-1 and dsa-worker-1 for the same reason; the warning it
# silences is about pickle deserialisation, and this worker's broker is not publicly reachable.
ENV C_FORCE_ROOT=true
CMD ["/bin/sh", "-c", "/opt/venv/bin/celery -A girder_worker.app:app worker \
     --queues ${PATHASSIST_QUEUE} --concurrency=1 --loglevel=info"]
