"""src/solar.js と同じ式・同じ API。TouchDesigner では Text DAT に貼るか、モジュールとして import して使う。"""
import json
import math
from datetime import datetime, timezone


def _norm360(a):
    return a % 360.0


def sun_position(dt, lat, lon):
    """dt はタイムゾーン付き datetime。azimuth: 北=0°, 東=90° / altitude: 大気差補正なし"""
    ts = dt.timestamp()
    jd = ts / 86400.0 + 2440587.5
    T = (jd - 2451545.0) / 36525.0
    L0 = _norm360(280.46646 + T * (36000.76983 + 0.0003032 * T))
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    Mr = math.radians(M)
    C = (math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
         + math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
         + math.sin(3 * Mr) * 0.000289)
    omega = 125.04 - 1934.136 * T
    lam = L0 + C - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(eps)) * math.sin(math.radians(lam))))
    y = math.tan(math.radians(eps / 2)) ** 2
    L0r = math.radians(L0)
    eot = 4 * math.degrees(y * math.sin(2 * L0r) - 2 * e * math.sin(Mr)
                           + 4 * e * y * math.sin(Mr) * math.cos(2 * L0r)
                           - 0.5 * y * y * math.sin(4 * L0r) - 1.25 * e * e * math.sin(2 * Mr))
    minutes_utc = (ts / 60.0) % 1440
    tst = (minutes_utc + eot + 4 * lon) % 1440
    ha = math.radians(tst / 4 - 180)
    latr, dr = math.radians(lat), math.radians(decl)
    cosz = math.sin(latr) * math.sin(dr) + math.cos(latr) * math.cos(dr) * math.cos(ha)
    alt = 90 - math.degrees(math.acos(max(-1.0, min(1.0, cosz))))
    az = _norm360(math.degrees(math.atan2(math.sin(ha),
                  math.cos(ha) * math.sin(latr) - math.tan(dr) * math.cos(latr))) + 180)
    return {"azimuth": az, "altitude": alt, "declination": decl, "equationOfTime": eot}


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def resolve_site(config, site_name=None):
    site_name = site_name or config["activeSite"]
    s = config["sites"].get(site_name)
    if s is None:
        raise KeyError(f'site "{site_name}" が config にありません')
    scr = s["screen"]
    facing = scr["facingAzimuth"]
    if scr["azimuthReference"] == "magnetic":
        facing += scr["magneticDeclination"]
    facing = _norm360(facing)
    window_az = s["window"].get("facingAzimuth")
    if window_az is None:
        side = s["window"]["side"]
        if side == "right":
            window_az = facing + 90
        elif side == "left":
            window_az = facing - 90
        else:
            raise ValueError(f'window.side は "left" か "right": {side}')
    return {
        "name": site_name,
        "label": s.get("label"),
        "latitude": s["latitude"],
        "longitude": s["longitude"],
        "utcOffsetMinutes": s["utcOffsetMinutes"],
        "facingAzimuth": facing,
        "rightAzimuth": _norm360(facing + 90),
        "windowAzimuth": _norm360(window_az),
        "windowSide": s["window"]["side"],
    }


def light_on_screen(sun, site):
    """光の進行方向をスクリーン座標へ。x=右, y=上, z=奥"""
    a = math.radians(sun["altitude"])
    x = -math.cos(a) * math.cos(math.radians(sun["azimuth"] - site["rightAzimuth"]))
    y = -math.sin(a)
    z = -math.cos(a) * math.cos(math.radians(sun["azimuth"] - site["facingAzimuth"]))
    incidence = math.cos(a) * math.cos(math.radians(sun["azimuth"] - site["windowAzimuth"]))
    length = math.hypot(x, y)
    return {
        "x": x, "y": y, "z": z,
        "dirX": x / length if length > 1e-9 else 0.0,
        "dirY": y / length if length > 1e-9 else -1.0,
        "windowIncidence": incidence,
        "entersWindow": sun["altitude"] > 0 and incidence > 0,
    }


def solar_state(dt, site):
    sun = sun_position(dt, site["latitude"], site["longitude"])
    return {"sun": sun, "light": light_on_screen(sun, site)}


if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    site = resolve_site(load_config(os.path.join(here, "..", "config", "site.json")))
    print(site)
    print(solar_state(datetime.now(timezone.utc), site))
