"""把 data/ 同步到 Cloudflare R2(S3 相容),網頁(GitHub Pages)從 R2 讀資料。
  設定(.env):R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_BUCKET
  沒設定就不上傳(本機照常運作)。

運作方式:
  - common 每寫一個檔(_atomic_write)、刪一個檔(remove)就記進待辦;排程每 30 秒 flush() 一次。
  - 排程啟動時 reconcile():列出 R2 上的檔,本機有但 R2 沒有 / 大小不同的補傳(程式停掉期間沒傳完的)。
    **只補傳、不刪除**:新電腦還沒有舊資料時,不會把 R2 上的歷史資料刪掉。

不上傳:每站月 CSV(stations/series,檔案太多,之後另做縣市彙整檔)、颱風原始歸檔、系集原始 CSV。

手動:
  python -m pipeline.r2 --reconcile     全部比對補傳
  python -m pipeline.r2 --cors          設定 CORS(需要 Admin 權限的 token;否則到 Cloudflare 後台設)
  python -m pipeline.r2 --check         測試連線"""
import argparse
import hashlib
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import config

log = logging.getLogger("pipeline")

EXCLUDE = ("stations/series/", "typhoon/cwa/", "typhoon/ens_raw/")
CORS_ORIGINS = ["https://benlin1124.github.io", "http://127.0.0.1:8765", "http://localhost:8765"]

_lock = threading.Lock()
_pending_put = set()
_pending_del = set()
_client = None
STATUS_EVERY_SEC = 600         # status.json 每分鐘都在變、網頁沒用到 → 最多 10 分鐘傳一次,省 R2 寫入次數
_status_sent = 0.0


def enabled():
    return all(os.environ.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"))


def bucket():
    return os.environ["R2_BUCKET"]


def client():
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config
        _client = boto3.client(
            "s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto", config=Config(retries={"max_attempts": 5, "mode": "standard"},
                                              max_pool_connections=16))
    return _client


def key_of(path):
    """本機路徑 → R2 key(data/ 底下的相對路徑);不上傳的回傳 None。"""
    try:
        rel = path.resolve().relative_to(config.DATA_DIR.resolve()).as_posix()
    except ValueError:
        return None
    if rel.startswith(EXCLUDE) or rel.endswith(".tmp"):
        return None
    return rel


def mark_put(path):
    k = key_of(path)
    if k:
        with _lock:
            _pending_put.add(k)
            _pending_del.discard(k)


def mark_del(path):
    k = key_of(path)
    if k:
        with _lock:
            _pending_del.add(k)
            _pending_put.discard(k)


def _headers(key):
    """index / status 不快取(一直更新);JSON 1 分鐘;格點 1 天(同一時間的檔不會再變)。"""
    name = key.rsplit("/", 1)[-1]
    if name in ("index.json", "status.json"):
        return "application/json; charset=utf-8", "no-cache"
    if key.endswith(".json"):
        return "application/json; charset=utf-8", "public, max-age=60"
    if key.endswith(".bin.gz"):
        return "application/octet-stream", "public, max-age=86400"   # 前端自己 gunzip,不設 Content-Encoding
    return "application/octet-stream", "public, max-age=300"


def _put(key):
    path = config.DATA_DIR / key
    if not path.exists():
        return
    ctype, cache = _headers(key)
    client().put_object(Bucket=bucket(), Key=key, Body=path.read_bytes(),
                        ContentType=ctype, CacheControl=cache)


def flush():
    """上傳 / 刪除待辦;失敗的放回待辦下次再試。回傳 (上傳數, 刪除數)。"""
    if not enabled():
        return 0, 0
    global _status_sent
    with _lock:
        puts, dels = sorted(_pending_put), sorted(_pending_del)
        _pending_put.clear()
        _pending_del.clear()
        if "status.json" in puts:
            if time.time() - _status_sent < STATUS_EVERY_SEC:
                puts.remove("status.json")
                _pending_put.add("status.json")          # 留到下次
            else:
                _status_sent = time.time()
    # index.json 最後傳:網頁讀到新 index 時,資料檔一定已經在了
    data_keys = [k for k in puts if not k.endswith("index.json")]
    idx_keys = [k for k in puts if k.endswith("index.json")]
    failed = []

    def safe(k):
        try:
            _put(k)
        except Exception as e:
            log.warning("R2 上傳失敗 %s:%s", k, e)
            failed.append(k)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(safe, data_keys))
        list(ex.map(safe, idx_keys))
    for i in range(0, len(dels), 1000):
        chunk = dels[i:i + 1000]
        try:
            client().delete_objects(Bucket=bucket(), Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
        except Exception as e:
            log.warning("R2 刪除失敗(%d 個):%s", len(chunk), e)
            with _lock:
                _pending_del.update(chunk)
    if failed:
        with _lock:
            _pending_put.update(failed)
    return len(puts) - len(failed), len(dels)


def remote_listing():
    out = {}
    pages = client().get_paginator("list_objects_v2").paginate(Bucket=bucket())
    for page in pages:
        for o in page.get("Contents", []):
            out[o["Key"]] = (o["Size"], o["ETag"].strip('"'))
    return out


def reconcile():
    """本機有、R2 沒有或內容不同 → 補傳(只補不刪)。"""
    if not enabled():
        log.info("R2 未設定(.env 沒有 R2_*),不上傳")
        return 0
    remote = remote_listing()
    todo = []
    for root, _, files in os.walk(config.DATA_DIR):
        for name in files:
            path = config.DATA_DIR.joinpath(root, name)
            k = key_of(path)
            if not k:
                continue
            size = path.stat().st_size
            r = remote.get(k)
            if r is None or r[0] != size or (name.endswith(".json") and size < 5_000_000
                                              and hashlib.md5(path.read_bytes()).hexdigest() != r[1]):
                todo.append(k)
    with _lock:
        _pending_put.update(todo)
    n, _ = flush()
    log.info("R2 比對完成:R2 上 %d 個檔,補傳 %d 個", len(remote), n)
    return n


def set_cors():
    client().put_bucket_cors(Bucket=bucket(), CORSConfiguration={"CORSRules": [{
        "AllowedOrigins": CORS_ORIGINS, "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600}]})
    print("CORS 已設定:", CORS_ORIGINS)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--cors", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if not enabled():
        raise SystemExit(".env 缺少 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET")
    if a.check:
        client().head_bucket(Bucket=bucket())
        print(f"連線成功:bucket {bucket()},目前 {len(remote_listing())} 個檔")
    if a.cors:
        set_cors()
    if a.reconcile:
        reconcile()
