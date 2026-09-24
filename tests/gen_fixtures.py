"""基準値を NREL SPA（pvlib）と、式を使わない素朴なベクトル射影で生成する。
fixtures はサイト値を内部に固定して持つので、config/site.json を変えてもテストは壊れない。"""
import json
import os

import numpy as np
import pandas as pd
import pvlib

HERE = os.path.dirname(os.path.abspath(__file__))

SITE = {
    "latitude": 35.692948823007555,
    "longitude": 139.7832292459908,
    "facingAzimuth": 66 - 7.5,
    "windowAzimuth": 66 - 7.5 + 90,
}

named = [
    "2026-06-21 12:00", "2026-12-22 12:00", "2026-03-20 12:00",
    "2026-09-24 09:00", "2026-09-24 12:00", "2026-09-24 15:00",
    "2026-09-24 05:40", "2026-09-24 17:40", "2030-01-01 08:00", "2035-07-15 16:30",
]
hourly = [f"2026-{m:02d}-15 {h:02d}:00" for m in range(1, 13) for h in range(5, 20)]
times = pd.DatetimeIndex(named + hourly).tz_localize("Asia/Tokyo")

spa = pvlib.solarposition.spa_python(times, SITE["latitude"], SITE["longitude"])


def unit(az, el):
    a, e = np.radians(az), np.radians(el)
    return np.array([np.cos(e) * np.sin(a), np.cos(e) * np.cos(a), np.sin(e)])  # ENU


F, W = SITE["facingAzimuth"], SITE["windowAzimuth"]
forward = unit(F, 0)
right = unit(F + 90, 0)
up = np.array([0.0, 0.0, 1.0])
window_n = unit(W, 0)

cases = []
for t, row in spa.iterrows():
    az, el = float(row["azimuth"]), float(row["elevation"])
    s = unit(az, el)
    L = -s
    inc = float(s @ window_n)
    cases.append({
        "utc": t.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
        "local": t.strftime("%Y-%m-%d %H:%M"),
        "azimuth": az,
        "altitude": el,
        "screen": {
            "x": float(L @ right), "y": float(L @ up), "z": float(L @ forward),
            "windowIncidence": inc,
            "entersWindow": bool(el > 0 and inc > 0),
        },
    })

out = {
    "source": f"pvlib {pvlib.__version__} spa_python (elevation = 大気差補正なし)",
    "site": SITE,
    "cases": cases,
}
with open(os.path.join(HERE, "fixtures.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"{len(cases)} cases -> tests/fixtures.json")
