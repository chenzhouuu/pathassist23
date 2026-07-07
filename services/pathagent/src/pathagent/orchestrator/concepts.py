"""Query-conditioned CONCH concept prompts for breast-pathology navigation.

These short, CONCH-caption-style phrases are embedded by the perception
subprocess and scored against patch features so navigation is steered toward
diagnostically salient regions (in addition to the free-text question).
"""

DIAGNOSTIC_CONCEPTS: list[str] = [
    "invasive ductal carcinoma",
    "invasive lobular carcinoma with single-file growth",
    "tumor cells infiltrating stroma",
    "high nuclear grade carcinoma",
    "ductal carcinoma in situ",
    "benign breast tissue with normal ducts and lobules",
]
