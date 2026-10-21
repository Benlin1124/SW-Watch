"""CWA 雨量格點:
  O-B0045-001 過去 1 小時雷達定量降雨估計(QPESUMS)→ data/rain/cwa/1h/
  O-A0040-004 日累積雨量格點                        → data/rain/cwa/today/
3h/6h/… 與自訂區間由前端把整點的 1h 檔加總。"""
import numpy as np

from .common import exists, fetch_cwa, grid_spec, log, parse_grid, save_grid, utc_stamp

RAIN_SCALE = 0.1   # uint16,0.1 mm 一階,上限 6553.4 mm


def run_qpe1h():
    layer = "rain/cwa/1h"
    ds = fetch_cwa("O-B0045-001")["dataset"]
    p = ds["datasetInfo"]["parameterSet"]
    stamp = utc_stamp(p["DateTime"])
    if exists(layer, stamp):
        return stamp
    nx, ny = int(p["GridDimensionX"]), int(p["GridDimensionY"])
    arr = parse_grid(ds["contents"]["content"], nx, ny, invalid=(-1,))
    spec = grid_spec(float(p["StartPointLongitude"]), float(p["StartPointLatitude"]),
                     float(p["GridResolution"]), nx, ny, np.uint16,
                     scale=RAIN_SCALE, offset=0.0, units="mm", twd67=True)
    save_grid(layer, stamp, arr, spec, source="CWA O-B0045-001",
              name="過去1小時雷達定量降雨估計", acc="1h")
    log.info("qpe1h %s 完成", stamp)
    return stamp


def run_daily():
    layer = "rain/cwa/today"
    ds = fetch_cwa("O-A0040-004")["dataset"]
    g = ds["GeoInfo"]
    stamp = utc_stamp(ds["DataTime"]["DateTime"])
    if exists(layer, stamp):
        return stamp
    nx, ny, dx = 67, 120, 0.03   # 規格寫在產品說明裡,JSON 沒給維度
    arr = parse_grid(ds["Resource"]["Content"], nx, ny, invalid=(-1,))
    spec = grid_spec(float(g["BottomLeftLongitude"]), float(g["BottomLeftLatitude"]),
                     dx, nx, ny, np.uint16, scale=RAIN_SCALE, offset=0.0,
                     units="mm", twd67=True)
    save_grid(layer, stamp, arr, spec, source="CWA O-A0040-004",
              name="日累積雨量(當日 00 時起)", acc="today")
    log.info("daily rain %s 完成", stamp)
    return stamp


def run():
    run_qpe1h()
    run_daily()


if __name__ == "__main__":
    run()
