"""What leaves the server for the Runs list, and what must not (Inc 6 · ticket 03).

The documents below are real ones, copied out of this deployment's `job` collection with the
token values shortened. Two of them carry live Girder credentials in fields that sit right next to
fields the Runs list needs, which is the whole reason `row()` builds its output field by field.
"""

from girder_pathassist.runs import (
    CANCELING,
    CLI_LANE,
    DEFAULT_LANE,
    ERROR,
    QUEUED,
    RUNNING,
    SUCCESS,
    UNFINISHED,
    chain_of,
    cli_item_id,
    failure_reason,
    has_started,
    item_id_of,
    job_types_query,
    lane_of,
    row,
    slide_key,
)

# A dispatched nuclei run, mid-flight. `kwargs` is exactly as Girder stores it.
NATIVE = {
    "_id": "6a6e4d9211ae438b623e18dd",
    "title": "Nuclei segmentation · 6a6e1ca82ae96ce927e33818",
    "type": "pathassist",
    "status": RUNNING,
    "created": "2026-08-01T19:48:34.110Z",
    "updated": "2026-08-01T19:48:35.306Z",
    "progress": {"message": "142 / 338 · nuclei", "total": 338, "current": 142},
    "kwargs": {"kind": "nuclei", "item": "6a6e1ca82ae96ce927e33818",
               "girder_token": "nr3AByqKOpFDeX9ywQqTbaevJn4gA20N"},
    "jobInfoSpec": {"headers": {"Girder-Token": "epSfHCOG5DNou4Pgl8a5IVIrNrGpI7zP"}},
    "pathassist": {"kind": "nuclei", "item": "6a6e1ca82ae96ce927e33818",
                   "artHash": "2cd90fdd354fdeb3", "queue": "pathassist"},
    "userId": "69be4029143be93cfca56a37",
}

# Compute Background Intensity, as slicer_cli_web wrote it.
CLI = {
    "_id": "6a6e4d99964397e5583e18df",
    "title": "Compute Background Intensity on TCGA-WT-AB44-01A-01-TS1.svs",
    "type": "dsarchive/histomicstk:latest#BackgroundIntensity",
    "status": SUCCESS,
    "created": "2026-08-01T19:48:41.268Z",
    "progress": None,
    "_original_params": {
        "slide_path": "6a3d59c8d59c30f37fd99be0",
        "sample_fraction": "0.1",
        "outputAnnotationFile": "TCGA-WT-AB44-BackgroundIntensity-2026-08-01.anot",
        "outputAnnotationFile_folder": "6a6e1ca82ae96ce927e33817",
        "girderToken": "nr3AByqKOpFDeX9ywQqTbaevJn4gA20NnYCVFE2CJKGalrotHWrk47GCOyYhvDy3",
    },
    "userId": "69be4029143be93cfca56a37",
}

#: The deployment's file collection, for the injected loader. The output folder id is present as a
#: *folder*, so a loader that ignored the collection it queried would resolve the wrong thing.
FILES = {"6a3d59c8d59c30f37fd99be0": {"_id": "6a3d59c8d59c30f37fd99be0",
                                      "itemId": "6a6e1ca82ae96ce927e33818"}}


def load_file(file_id):
    return FILES.get(file_id)


class TestWhichJobsAreRuns:
    def test_the_two_families_and_nothing_else(self):
        """`slicer_cli_web` types a CLI job `image#cli`; image pulls and imports are neither."""
        query = job_types_query()
        assert query == {"$or": [{"type": "pathassist"}, {"type": {"$regex": "#"}}]}

    def test_canceling_still_occupies_the_queue(self):
        """824 is where `jobs.cancel` parks a live job until its runner settles it.

        A stopping run still holds the worker, so counting it as finished would tell the run
        behind it that it is next when it is not.
        """
        assert CANCELING in UNFINISHED


class TestWhetherARunEverStarted:
    """The fact that decides what a cancelled row says.

    Measured 2026-08-01: cancelling a *queued* run leaves it at 824 for as long as the run ahead
    of it lasts, because celery holds the revoked message and only drops it at execute time. The
    status history is what separates that from a cooperative stop in flight.
    """

    def test_a_run_that_reached_running_has_started(self):
        assert has_started({"timestamps": [{"status": QUEUED}, {"status": RUNNING}]})

    def test_a_run_still_on_the_queue_has_not(self):
        assert not has_started({"timestamps": [{"status": QUEUED}]})

    def test_a_job_with_no_history_has_not(self):
        assert not has_started({})

    def test_it_rides_on_every_row_including_an_unnamed_one(self):
        """Queue mechanics, not ownership — an unreadable row still has to be countable."""
        job = dict(NATIVE, timestamps=[{"status": QUEUED}])
        assert row(job, readable=False, mine=False,
                   item_id=None, slide_name=None)["started"] is False


class TestWhichQueueARunCompetesFor:
    def test_a_dispatch_carries_its_own_queue(self):
        assert lane_of(NATIVE) == "pathassist"

    def test_a_job_from_before_the_queue_was_stored_falls_back(self):
        old = dict(NATIVE, pathassist={"kind": "nuclei", "item": "x", "artHash": "y"})
        assert lane_of(old) == DEFAULT_LANE

    def test_a_docker_cli_is_a_different_lane(self):
        """It runs on the DSA worker. A nuclei run at concurrency=1 is not waiting behind it."""
        assert lane_of(CLI) == CLI_LANE


class TestWhichSlideARunIsAbout:
    def test_a_native_run_says_so_itself(self):
        assert item_id_of(NATIVE, load_file) == "6a6e1ca82ae96ce927e33818"

    def test_a_cli_run_is_recovered_from_its_primary_file_input(self):
        """Reversing `prepare_task.py:298-310`: the first param that names a real file."""
        assert cli_item_id(CLI, load_file) == "6a6e1ca82ae96ce927e33818"

    def test_the_output_folder_id_is_not_mistaken_for_the_input(self):
        """It is a well-formed ObjectId that loads as no file, which is the only thing separating
        it from the slide."""
        only_output = dict(CLI, _original_params={
            "outputAnnotationFile_folder": "6a6e1ca82ae96ce927e33817"})
        assert cli_item_id(only_output, load_file) is None

    def test_a_token_is_never_read_as_an_id(self):
        assert cli_item_id({"_original_params": {"girderToken": "n" * 64}}, load_file) is None

    def test_a_cli_with_no_recorded_params_has_no_slide(self):
        assert item_id_of({"type": "a#b"}, load_file) is None


class TestWhenTwoRunsAreOnTheSameSlide:
    """The DEMO slide, measured 2026-08-01.

    Item `…33818` is `copyOfItem: …9bdf` and both carry `largeImage.fileId: …9be0`. A native run
    names the copy (the gateway was handed the item the user opened); a docker CLI resolves back
    through the file to the original. Two item ids, one slide, and grouping has to say so.
    """

    COPY = {"name": "TCGA-WT-AB44.svs", "largeImage": {"fileId": "6a3d59c8d59c30f37fd99be0"}}
    ORIGIN = {"name": "TCGA-WT-AB44.svs", "largeImage": {"fileId": "6a3d59c8d59c30f37fd99be0"}}

    def test_the_copy_and_the_original_share_a_key(self):
        assert (slide_key("6a6e1ca82ae96ce927e33818", self.COPY)
                == slide_key("6a3d59c8d59c30f37fd99bdf", self.ORIGIN))

    def test_an_item_with_no_tile_source_keys_on_itself(self):
        assert slide_key("6a6e1ca82ae96ce927e33818", {"name": "notes.txt"}) \
            == "6a6e1ca82ae96ce927e33818"

    def test_an_unresolvable_item_has_no_key(self):
        assert slide_key(None, None) is None


class TestTheFailureReason:
    #: A real failure off this deployment (2026-08-01). Note the order: girder_worker puts the
    #: exception first and the frames after it (`app.py:180`), which is *not* Python's own
    #: traceback layout — so "take the tail" returns the innermost `raise` and not the reason.
    REAL = ["ServiceRefused: nuclei was refused (400): slide_ref is required\n"
            '  File "/opt/venv/.../celery/app/trace.py", line 453, in trace_task\n'
            "    R = retval = fun(*args, **kwargs)\n"
            '  File "/opt/girder_pathassist/src/girder_pathassist/runner.py", line 48, in submit\n'
            '    raise ServiceRefused(f"{kind} was refused ({resp.status_code}): {detail}")\n']

    def test_the_reason_is_the_first_line_and_not_the_last(self):
        assert failure_reason(self.REAL) == \
            "ServiceRefused: nuclei was refused (400): slide_ref is required"

    def test_the_stack_under_it_is_not_the_reason(self):
        assert "raise ServiceRefused" not in failure_reason(self.REAL)
        assert "trace.py" not in failure_reason(self.REAL)

    def test_a_docker_cli_reads_its_last_chunk_not_its_container_output(self):
        """The container's stdout is earlier chunks; `gw_task_failure` appends after all of it."""
        log = ["Creating dask LocalCluster with 24 worker(s)\n" * 40,
               "ResourceWarning: unclosed file\n",
               "DockerException: container exited with code 1\n  File \"docker_run.py\"\n"]
        assert failure_reason(log) == "DockerException: container exited with code 1"

    def test_a_reason_longer_than_the_budget_is_cut_rather_than_dropped(self):
        assert failure_reason(["ValueError: " + "x" * 900], limit=40) == \
            ("ValueError: " + "x" * 900)[:40]

    def test_a_multi_line_exception_message_survives_to_the_frames(self):
        log = ["RuntimeError: two things went wrong:\n  - the first\n"
               '  File "driver.py", line 78, in run_analysis\n']
        assert failure_reason(log) == "RuntimeError: two things went wrong:\n  - the first"

    def test_blank_lines_are_not_the_reason(self):
        assert failure_reason(["\n\n  \n"]) is None

    def test_no_log_is_no_reason(self):
        assert failure_reason(None) is None
        assert failure_reason([]) is None

    def test_a_legacy_string_log_still_reads(self):
        """`models/job.py:306` still carries the pre-list format, so this can arrive as a str."""
        assert failure_reason("boom") == "boom"


class TestWhatLeavesTheServer:
    def test_no_credential_reaches_the_row(self):
        """`kwargs`, `_original_params` and `jobInfoSpec` each hold a live token."""
        rendered = repr(row(NATIVE, readable=True, mine=True,
                            item_id="6a6e1ca82ae96ce927e33818", slide_name="TCGA-WT-AB44.svs"))
        assert "nr3AByqK" not in rendered
        assert "epSfHCOG" not in rendered
        assert "kwargs" not in rendered
        assert "jobInfoSpec" not in rendered

    def test_a_readable_row_carries_what_the_list_shows(self):
        r = row(NATIVE, readable=True, mine=True,
                item_id="6a6e1ca82ae96ce927e33818", slide_name="TCGA-WT-AB44.svs")
        assert r["title"] == "Nuclei segmentation · 6a6e1ca82ae96ce927e33818"
        assert r["kind"] == "nuclei"
        assert r["slideName"] == "TCGA-WT-AB44.svs"
        assert r["progress"] == {"current": 142, "total": 338, "message": "142 / 338 · nuclei"}
        assert r["lane"] == "pathassist"

    def test_an_unreadable_row_is_counted_but_not_named(self):
        """D3's bargain: the run ahead of you is visible enough to explain your wait, and no more.

        Position needs `created`, `status` and `lane` — none of which say whose work it is.
        """
        r = row(NATIVE, readable=False, mine=False, item_id=None, slide_name=None)
        assert r["status"] == RUNNING and r["lane"] == "pathassist" and r["created"]
        assert "nuclei" not in repr(r).lower()
        assert "slideName" not in r and "itemId" not in r and "reason" not in r

    def test_the_reason_rides_only_on_a_failure(self):
        ok = row(NATIVE, readable=True, mine=True, item_id=None, slide_name=None)
        assert "reason" not in ok

        failed = row(dict(NATIVE, status=ERROR, log=["RuntimeError: nuclei failed"]),
                     readable=True, mine=True, item_id=None, slide_name=None)
        assert failed["reason"] == "RuntimeError: nuclei failed"

    def test_a_cli_row_has_no_kind_and_says_so_by_omission(self):
        r = row(CLI, readable=True, mine=True,
                item_id="6a6e1ca82ae96ce927e33818", slide_name="TCGA-WT-AB44.svs")
        assert r["kind"] is None
        assert r["progress"] is None
        assert r["type"] == "dsarchive/histomicstk:latest#BackgroundIntensity"


class TestChains:
    """A multi-step submission, held together by a field rather than by a parent job
    (Inc 6 · 07)."""

    def chained(self, step, total=3, **over):
        pa = {**NATIVE["pathassist"],
              "chain": {"id": "c1", "step": step, "total": total,
                        "label": "Feature index", "kinds": ["segmentation", "patching", "features"],
                        **over}}
        return {**NATIVE, "pathassist": pa}

    def test_a_step_says_which_submission_it_is_part_of_and_where(self):
        assert chain_of(self.chained(2)) == {
            "id": "c1", "step": 2, "total": 3, "label": "Feature index",
            "kinds": ["segmentation", "patching", "features"],
        }

    def test_a_single_run_is_not_a_chain(self):
        """`runAnalysis` writes no chain field; a caller that writes `total: 1` gets none either."""
        assert chain_of(NATIVE) is None
        assert chain_of(self.chained(1, total=1)) is None

    def test_a_chain_without_an_id_cannot_group_anything(self):
        assert chain_of(self.chained(1, id="")) is None

    def test_a_malformed_position_is_dropped_rather_than_shown(self):
        """Step and total are counted with, so a string in either is not a chain to render."""
        assert chain_of(self.chained("2")) is None
        assert chain_of(self.chained(2, total="3")) is None

    def test_the_row_carries_it_only_when_there_is_one(self):
        plain = row(NATIVE, readable=True, mine=True, item_id=None, slide_name=None)
        assert "chain" not in plain
        grouped = row(self.chained(2), readable=True, mine=True, item_id=None, slide_name=None)
        assert grouped["chain"]["step"] == 2

    def test_an_unreadable_row_says_nothing_about_the_chain(self):
        """`readable` gates everything about *what* the work is; a chain label is part of that."""
        hidden = row(self.chained(2), readable=False, mine=False, item_id=None, slide_name=None)
        assert "chain" not in hidden
