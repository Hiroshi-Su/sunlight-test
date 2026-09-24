// three.js 非依存。src/solar.py と同じ式・同じ API を保つこと（tests/ で両方を同じ基準値で検証）。

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const norm360 = (a) => ((a % 360) + 360) % 360;

// NOAA / Meeus 簡略法。azimuth: 北=0°, 東=90° / altitude: 大気差補正なし
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const L0 = norm360(280.46646 + T * (36000.76983 + 0.0003032 * T));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const L0r = L0 * RAD;
  const eot = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr)
            + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
            - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  const minutesUTC = (((date.getTime() / 60000) % 1440) + 1440) % 1440;
  const tst = (((minutesUTC + eot + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * RAD;
  const latr = lat * RAD;
  const dr = decl * RAD;
  const cosZ = Math.sin(latr) * Math.sin(dr) + Math.cos(latr) * Math.cos(dr) * Math.cos(ha);
  const altitude = 90 - Math.acos(Math.min(1, Math.max(-1, cosZ))) * DEG;
  const azimuth = norm360(
    Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latr) - Math.tan(dr) * Math.cos(latr)) * DEG + 180,
  );
  return { azimuth, altitude, declination: decl, equationOfTime: eot };
}

export function resolveSite(config, siteName = config.activeSite) {
  const s = config.sites[siteName];
  if (!s) throw new Error(`site "${siteName}" が config にありません`);
  const scr = s.screen;
  const facing = norm360(
    scr.azimuthReference === 'magnetic' ? scr.facingAzimuth + scr.magneticDeclination : scr.facingAzimuth,
  );
  let windowAz = s.window.facingAzimuth;
  if (windowAz == null) {
    if (s.window.side === 'right') windowAz = facing + 90;
    else if (s.window.side === 'left') windowAz = facing - 90;
    else throw new Error(`window.side は "left" か "right": ${s.window.side}`);
  }
  return {
    name: siteName,
    label: s.label,
    latitude: s.latitude,
    longitude: s.longitude,
    utcOffsetMinutes: s.utcOffsetMinutes,
    facingAzimuth: facing,
    rightAzimuth: norm360(facing + 90),
    windowAzimuth: norm360(windowAz),
    windowSide: s.window.side,
  };
}

// 光の進行方向をスクリーン座標へ。x=右, y=上, z=奥（鑑賞者から見てスクリーンの向こう側）
export function lightOnScreen(sun, site) {
  const a = sun.altitude * RAD;
  const x = -Math.cos(a) * Math.cos((sun.azimuth - site.rightAzimuth) * RAD);
  const y = -Math.sin(a);
  const z = -Math.cos(a) * Math.cos((sun.azimuth - site.facingAzimuth) * RAD);
  const windowIncidence = Math.cos(a) * Math.cos((sun.azimuth - site.windowAzimuth) * RAD);
  const len = Math.hypot(x, y);
  return {
    x, y, z,
    dirX: len > 1e-9 ? x / len : 0,
    dirY: len > 1e-9 ? y / len : -1,
    windowIncidence,
    entersWindow: sun.altitude > 0 && windowIncidence > 0,
  };
}

export function solarState(date, site) {
  const sun = sunPosition(date, site.latitude, site.longitude);
  return { sun, light: lightOnScreen(sun, site) };
}
