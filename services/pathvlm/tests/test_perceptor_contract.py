from pathvlm_service.perceptor import effective_magnification, read_plan


def test_request_at_native_is_unchanged():
    assert effective_magnification(40, 40, default=20) == 40


def test_over_native_request_is_clamped_to_native():
    assert effective_magnification(40, 80, default=20) == 40  # a 40x slide has no real 80x


def test_none_request_falls_back_to_default():
    assert effective_magnification(40, None, default=20) == 20


def test_default_is_itself_clamped_to_native():
    # a 10x slide can't reach the 20x default
    assert effective_magnification(10, None, default=20) == 10


def test_small_region_keeps_the_target_magnification():
    plan = read_plan(native_mag=40, target_mag=40, out_px=512, bbox={"width": 512, "height": 512})
    assert plan.magnification == 40 and plan.out_px == 512
    assert plan.effective_mag == 40


def test_large_region_output_cap_lowers_effective_mag():
    # An 8192 base-px region at 20x would render to 4096 px; the 512 cap binds → far below 20x.
    plan = read_plan(native_mag=40, target_mag=20, out_px=512, bbox={"width": 8192, "height": 8192})
    assert plan.effective_mag < 20
    assert plan.effective_mag == 2.5  # 40 * 512 / 8192
