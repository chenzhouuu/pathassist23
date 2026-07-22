from agent.loop.pannuke import CLASS_HEX, PANNUKE_NAMES


def test_pannuke_names_in_id_order():
    assert PANNUKE_NAMES == ["Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"]


def test_class_hex_covers_every_name():
    assert set(CLASS_HEX) == set(PANNUKE_NAMES)
    assert CLASS_HEX["Neoplastic"] == "#ff0000"
    assert CLASS_HEX["Inflammatory"] == "#22dd4d"
    assert CLASS_HEX["Epithelial"] == "#ff9f44"
