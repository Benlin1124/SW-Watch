"""雷達整合回波 O-A0059-001 → data/radar/{stamp}.bin.gz(uint8,0.5 dBZ 一階)。"""
import numpy as np

from .common import check_update, fetch_cwa, grid_spec, log, parse_grid, save_grid, utc_stamp

LAYER = "radar"


def run():
    """回傳 (狀態, 資料時間, 上一筆時間);狀態見 common.check_update。"""
    ds = fetch_cwa("O-A0059-001")["dataset"]
    p = ds["datasetInfo"]["parameterSet"]
    stamp = utc_stamp(p["DateTime"])
    status, prev = check_update(LAYER, stamp)
    if status != "new":
        return status, stamp, prev
    nx, ny = int(p["GridDimensionX"]), int(p["GridDimensionY"])
    # -999 = 觀測範圍外 / 品管移除 → nodata;-99 = 範圍內無回波 → 存成 raw 0(前端透明,但查值時可分辨)
    arr = parse_grid(ds["contents"]["content"], nx, ny, invalid=(-999,))
    arr[arr <= -99] = -32.0
    spec = grid_spec(float(p["StartPointLongitude"]), float(p["StartPointLatitude"]),
                     float(p["GridResolution"]), nx, ny, np.uint8,
                     scale=0.5, offset=-32.0, units="dBZ", twd67=True)
    save_grid(LAYER, stamp, arr, spec, source="CWA O-A0059-001", name="雷達整合回波")
    log.info("radar %s 完成", stamp)
    return status, stamp, prev


if __name__ == "__main__":
    print(run())
