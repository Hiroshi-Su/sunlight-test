import json
import os
import sys
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import solar  # noqa: E402

with open(os.path.join(HERE, "fixtures.json"), encoding="utf-8") as f:
    FX = json.load(f)
SITE = {**FX["site"], "rightAzimuth": (FX["site"]["facingAzimuth"] + 90) % 360}
TOL_DEG = 0.03


def ang_diff(a, b):
    return abs((a - b + 540) % 360 - 180)


class SolarTest(unittest.TestCase):
    def test_sun_position_matches_spa(self):
        import math
        max_az = max_alt = 0.0
        for c in FX["cases"]:
            dt = datetime.fromisoformat(c["utc"].replace("Z", "+00:00"))
            s = solar.sun_position(dt, SITE["latitude"], SITE["longitude"])
            d_alt = abs(s["altitude"] - c["altitude"])
            d_az = ang_diff(s["azimuth"], c["azimuth"]) * math.cos(math.radians(c["altitude"]))
            max_az, max_alt = max(max_az, d_az), max(max_alt, d_alt)
            self.assertLess(d_alt, TOL_DEG, c["local"])
            self.assertLess(d_az, TOL_DEG, c["local"])
        print(f"\n  max |daz*cos(alt)|={max_az:.4f}  max |dalt|={max_alt:.4f}  ({len(FX['cases'])} cases)")

    def test_screen_projection_matches_vectors(self):
        for c in FX["cases"]:
            l = solar.light_on_screen({"azimuth": c["azimuth"], "altitude": c["altitude"]}, SITE)
            for k in ("x", "y", "z", "windowIncidence"):
                self.assertAlmostEqual(l[k], c["screen"][k], places=9, msg=f'{c["local"]} {k}')
            self.assertEqual(l["entersWindow"], c["screen"]["entersWindow"], c["local"])

    def test_resolve_active_config(self):
        cfg = solar.load_config(os.path.join(HERE, "..", "config", "site.json"))
        site = solar.resolve_site(cfg)
        self.assertIn(site["windowSide"], ("left", "right"))
        self.assertTrue(0 <= site["facingAzimuth"] < 360)


if __name__ == "__main__":
    unittest.main()
