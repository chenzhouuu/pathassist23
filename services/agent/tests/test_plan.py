"""Planning a preprocess chain (Inc 6 · 07).

Pure, against a doubled `address` callable, because the two things that are easy to get wrong here
are arithmetic rather than networking: which steps a slide still needs, and what each one is called.
"""

import pytest

from agent.gateway.plan import (
    ORDER,
    Step,
    address_chain,
    match_feature_spec,
    missing_suffix,
    plan,
    satisfies_spec,
)

SEG = {"segmenter": "hest", "seg_conf_thresh": 0.5}
TILE = {"mag": 20, "patch_size": 512, "overlap": 0}
ENC = {"encoder": "conch_v1"}
TASK = {"task_id": "brca_idc_ilc"}
PARAMS = {"segmentation": SEG, "patching": TILE, "features": ENC, "prediction": TASK}


def fake_address(seen=None):
    """A service whose hash is a readable function of kind and parent, so tests can assert on it."""
    async def address(kind, params):
        if seen is not None:
            seen.append((kind, dict(params)))
        parent = params.get("seg_hash") or params.get("patch_hash") or params.get("feat_hash")
        return {
            "kind": kind,
            "art_hash": f"{kind[:4]}:{parent or 'root'}",
            # The service resolves defaults and adds what only it knows — `impl` is the one that
            # matters, because it is in the address and nobody typed it.
            "params": {**params, "impl": "trident"},
        }
    return address


class TestAddressing:
    @pytest.mark.asyncio
    async def test_every_step_up_to_the_target_is_named(self):
        steps = await address_chain(fake_address(), "features", PARAMS)
        assert [s.kind for s in steps] == ["segmentation", "patching", "features"]

    @pytest.mark.asyncio
    async def test_each_step_is_addressed_against_the_one_before_it(self):
        steps = await address_chain(fake_address(), "prediction", PARAMS)
        assert [s.parent_hash for s in steps] == [None] + [s.art_hash for s in steps[:-1]]

    @pytest.mark.asyncio
    async def test_the_parent_is_supplied_by_the_plan_not_by_the_caller(self):
        """A caller cannot name a patch grid's segmentation: it is whatever step 1 came out as."""
        seen = []
        await address_chain(fake_address(seen), "features", PARAMS)
        assert seen[1][1]["seg_hash"] == "segm:root"
        assert seen[2][1]["patch_hash"] == "patc:segm:root"

    @pytest.mark.asyncio
    async def test_the_step_records_what_the_service_resolved(self):
        """`impl` is part of the address and nobody requested it, so the row has to carry it."""
        steps = await address_chain(fake_address(), "segmentation", PARAMS)
        assert steps[0].params["impl"] == "trident"
        assert steps[0].params["segmenter"] == "hest"

    @pytest.mark.asyncio
    async def test_a_target_outside_the_chain_is_refused(self):
        with pytest.raises(ValueError):
            await address_chain(fake_address(), "nuclei", PARAMS)

    def test_the_order_is_the_dag(self):
        assert ORDER == ("segmentation", "patching", "features", "prediction")


class TestWhatIsMissing:
    def steps(self):
        return [Step(kind=k, art_hash=k[:4]) for k in ORDER]

    def test_nothing_to_run_when_the_target_is_already_built(self):
        assert missing_suffix(self.steps(), {"pred"}) == []

    def test_a_built_parent_stops_the_walk(self):
        needed = missing_suffix(self.steps(), {"feat"})
        assert [s.kind for s in needed] == ["prediction"]

    def test_an_empty_slide_runs_the_whole_chain(self):
        assert [s.kind for s in missing_suffix(self.steps(), set())] == list(ORDER)

    def test_a_hole_below_a_built_step_is_not_refilled(self):
        """Bytes are the artifact. A feature index that exists does not need its patch grid back —
        rebuilding one to reach the other is minutes of GPU spent on something nobody will read."""
        needed = missing_suffix(self.steps(), {"feat"})   # 'patc' and 'segm' both absent
        assert [s.kind for s in needed] == ["prediction"]

    @pytest.mark.asyncio
    async def test_plan_addresses_then_trims(self):
        steps = await plan(fake_address(), target="features", params_by_kind=PARAMS,
                           have={"segm:root"})
        assert [s.kind for s in steps] == ["patching", "features"]
        assert steps[0].parent_hash == "segm:root"


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

    def test_the_segmenter_is_deliberately_not_compared(self):
        """It propagates into every downstream hash, so comparing it would reject valid indexes."""
        assert satisfies_spec(
            [{**self.PATCH, "params": {**self.PATCH["params"], "segmenter": "otsu"}}, self.FEAT],
            self.FEAT, self.SPEC,
        )
