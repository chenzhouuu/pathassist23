"""One planner, for every kind (Inc 6 · 07–08).

Pure, against a doubled `address` callable, because what is easy to get wrong here is arithmetic
rather than networking: which steps a slide still needs, in what order, and what each is called.

The hash a fake service returns is `kind:parent1+parent2`, so an assertion can read the DAG off the
string and a step addressed against the wrong upstream fails visibly rather than subtly.
"""

import pytest

from agent.gateway.plan import (
    DEPENDS_ON,
    SCOPED_KINDS,
    Step,
    UnplannableRun,
    address_run,
    match_feature_spec,
    missing,
    plan,
    satisfies_spec,
)

SEG = {"segmenter": "hest", "seg_conf_thresh": 0.5}
TILE = {"mag": 20, "patch_size": 512, "overlap": 0}
ENC = {"encoder": "conch_v1"}
TASK = {"task_id": "brca_idc_ilc"}
PARAMS = {"segmentation": SEG, "patching": TILE, "features": ENC, "prediction": TASK,
          "nuclei": {}, "tissue": {}, "biomarker": {}}

PARENTS = ("seg_hash", "patch_hash", "feat_hash", "nuclei_hash")


def fake_address(seen=None):
    """A service whose hash is a readable function of kind and upstreams."""
    async def address(kind, params):
        if seen is not None:
            seen.append((kind, dict(params)))
        ups = "+".join(str(params[k]) for k in PARENTS if params.get(k)) or "root"
        return {
            "kind": kind,
            "art_hash": f"{kind[:4]}:{ups}",
            # The service resolves defaults and adds what only it knows — `impl` is the one that
            # matters, because it is in the address and nobody typed it.
            "params": {"impl": "trident"},
        }
    return address


class TestTheGraph:
    def test_every_dispatchable_kind_has_a_dependency_row(self):
        assert set(DEPENDS_ON) == {
            "segmentation", "patching", "features", "prediction", "nuclei", "tissue", "biomarker",
        }

    def test_the_marker_map_is_the_one_with_two_upstreams(self):
        """Which is why this is a DAG walk. A chain walk cannot express it at all."""
        assert [n.kind for n in DEPENDS_ON["biomarker"]] == ["segmentation", "nuclei"]


class TestAddressing:
    @pytest.mark.asyncio
    async def test_the_whole_preprocess_chain_is_named(self):
        steps = await address_run(fake_address(), "prediction", PARAMS)
        assert [s.kind for s in steps] == [
            "segmentation", "patching", "features", "prediction"]

    @pytest.mark.asyncio
    async def test_a_marker_map_names_both_of_its_upstreams_before_itself(self):
        steps = await address_run(fake_address(), "biomarker", PARAMS)
        assert [s.kind for s in steps] == ["segmentation", "nuclei", "biomarker"]
        # The segmentation is addressed once and used twice — by the nuclei run and by the map.
        seg = steps[0].art_hash
        assert seg in steps[1].needs and seg in steps[2].needs

    @pytest.mark.asyncio
    async def test_an_upstream_the_caller_named_is_not_planned(self):
        """Naming it asserts it exists. Reconstructing the params it happened to be built with
        would be work in service of a question nobody asked."""
        steps = await address_run(
            fake_address(), "biomarker", {**PARAMS, "biomarker": {"nuclei_hash": "mine"}})
        assert [s.kind for s in steps] == ["segmentation", "biomarker"]
        assert "mine" in steps[-1].needs

    @pytest.mark.asyncio
    async def test_a_region_run_needs_no_segmentation_to_start(self):
        """A drawn rectangle is segmented by its own edges. `when` is what says so."""
        steps = await address_run(
            fake_address(), "nuclei", {**PARAMS, "nuclei": {"bbox": {"x": 0}}})
        assert [s.kind for s in steps] == ["nuclei"]

    @pytest.mark.asyncio
    async def test_a_whole_slide_run_does(self):
        steps = await address_run(fake_address(), "nuclei", PARAMS)
        assert [s.kind for s in steps] == ["segmentation", "nuclei"]

    @pytest.mark.asyncio
    async def test_one_submission_uses_one_segmentation(self):
        """A marker map that names its contours must not get a second set planned underneath it
        for the nuclei step. Measured: it did, and the two would have been cut identically."""
        seen = []
        steps = await address_run(
            fake_address(seen), "biomarker", {**PARAMS, "biomarker": {"seg_hash": "mine"}})
        assert [s.kind for s in steps] == ["nuclei", "biomarker"]
        nuclei = next(p for kind, p in seen if kind == "nuclei")
        assert nuclei["seg_hash"] == "mine"

    @pytest.mark.asyncio
    async def test_an_implicit_upstream_inherits_the_callers_region(self):
        """A marker map over a rectangle needs nuclei *in that rectangle*. Planning the upstream
        whole-slide is an hour of GPU nobody asked for."""
        seen = []
        bbox = {"x": 10, "y": 10, "width": 512, "height": 512}
        await address_run(fake_address(seen), "biomarker",
                          {**PARAMS, "biomarker": {"bbox": bbox}})
        nuclei = next(p for kind, p in seen if kind == "nuclei")
        assert nuclei["bbox"] == bbox
        assert SCOPED_KINDS == {"nuclei", "tissue", "biomarker"}

    @pytest.mark.asyncio
    async def test_the_step_records_what_the_service_resolved(self):
        steps = await address_run(fake_address(), "segmentation", PARAMS)
        assert steps[0].params["impl"] == "trident"
        assert steps[0].params["segmenter"] == "hest"

    @pytest.mark.asyncio
    async def test_the_parents_stay_in_the_params_the_service_is_called_with(self):
        steps = await address_run(fake_address(), "patching", PARAMS)
        assert steps[-1].params["seg_hash"] == steps[0].art_hash

    @pytest.mark.asyncio
    async def test_a_target_the_planner_has_no_table_for_is_refused(self):
        with pytest.raises(UnplannableRun):
            await address_run(fake_address(), "copilot", PARAMS)


class TestWhatIsMissing:
    def chain(self):
        """segmentation → patching → features → prediction, as `address_run` would return it."""
        out, parent = [], None
        for kind in ("segmentation", "patching", "features", "prediction"):
            h = kind[:4]
            out.append(Step(kind=kind, art_hash=h, needs=(parent,) if parent else ()))
            parent = h
        return out

    def test_nothing_to_run_when_the_target_is_already_built(self):
        assert missing(self.chain(), {"pred"}) == []

    def test_a_built_parent_stops_the_marking(self):
        assert [s.kind for s in missing(self.chain(), {"feat"})] == ["prediction"]

    def test_an_empty_slide_runs_everything(self):
        assert len(missing(self.chain(), set())) == 4

    def test_a_hole_below_a_built_step_is_not_refilled(self):
        """Bytes are the artifact. A feature index that exists does not need its patch grid back —
        rebuilding one to reach the other is minutes of GPU spent on something nobody will read."""
        assert [s.kind for s in missing(self.chain(), {"feat"})] == ["prediction"]

    def test_a_second_upstream_is_marked_too(self):
        steps = [
            Step(kind="segmentation", art_hash="s"),
            Step(kind="nuclei", art_hash="n", needs=("s",)),
            Step(kind="biomarker", art_hash="b", needs=("s", "n")),
        ]
        assert [s.kind for s in missing(steps, set())] == ["segmentation", "nuclei", "biomarker"]

    def test_only_the_missing_branch_of_a_fork_is_kept(self):
        steps = [
            Step(kind="segmentation", art_hash="s"),
            Step(kind="nuclei", art_hash="n", needs=("s",)),
            Step(kind="biomarker", art_hash="b", needs=("s", "n")),
        ]
        # The nuclei exist; the contours they were cut against do not have to come back for the
        # map, which names them directly and finds them there.
        assert [s.kind for s in missing(steps, {"n", "s"})] == ["biomarker"]

    @pytest.mark.asyncio
    async def test_plan_returns_the_whole_shape_and_the_part_left_to_do(self):
        everything, todo = await plan(
            fake_address(), target="features", params_by_kind=PARAMS, have={"segm:root"})
        assert [s.kind for s in everything] == ["segmentation", "patching", "features"]
        assert [s.kind for s in todo] == ["patching", "features"]

    @pytest.mark.asyncio
    async def test_the_target_is_addressed_even_when_there_is_nothing_to_run(self):
        """The caller answers with the artifact the slide already has, so it needs its name."""
        everything, todo = await plan(
            fake_address(), target="segmentation", params_by_kind=PARAMS, have={"segm:root"})
        assert todo == [] and everything[-1].art_hash == "segm:root"


class TestFeatureSpec:
    SPEC = {"encoder": "conch_v1", "mag": 20, "patch_size": 512, "overlap": 0}
    PATCH = {"kind": "patching", "art_hash": "p1",
             "params": {"mag": 20, "patch_size": 512, "overlap": 0}}
    FEAT = {"kind": "features", "art_hash": "f1", "parent_hash": "p1",
            "params": {"encoder": "conch_v1"}}

    def test_a_matching_index_is_found(self):
        assert match_feature_spec([self.PATCH, self.FEAT], self.SPEC) is self.FEAT

    def test_the_encoder_has_to_be_the_one_the_weights_were_fitted_on(self):
        other = {**self.FEAT, "params": {"encoder": "uni_v2"}}
        assert match_feature_spec([self.PATCH, other], self.SPEC) is None

    def test_the_geometry_is_read_off_the_patching_parent(self):
        coarse = {**self.PATCH, "params": {"mag": 10, "patch_size": 512, "overlap": 0}}
        assert match_feature_spec([coarse, self.FEAT], self.SPEC) is None

    def test_an_unverifiable_index_is_not_claimed_as_a_match(self):
        """No parent row ⇒ the geometry cannot be checked. Running anyway would be a prediction on
        whatever tiling happened to be there, reported as the one the task declares."""
        assert match_feature_spec([self.FEAT], self.SPEC) is None

    def test_a_row_with_no_params_at_all_is_not_a_match_and_not_a_crash(self):
        assert match_feature_spec([self.PATCH, {**self.FEAT, "params": None}], self.SPEC) is None

    def test_the_segmenter_is_deliberately_not_compared(self):
        """It propagates into every downstream hash, so comparing it would reject valid indexes."""
        assert satisfies_spec(
            [{**self.PATCH, "params": {**self.PATCH["params"], "segmenter": "otsu"}}, self.FEAT],
            self.FEAT, self.SPEC,
        )
