"""Fetch one market via AKShare. stdout is a single UTF-8 JSON envelope."""
import argparse
import contextlib
import json
import re
import sys


def text(value):
    value = str(value).strip()
    return "" if value.lower() in ("", "nan", "none", "<na>") else value


def normalize_rows(rows, market):
    result = {}
    for row in rows:
        if market == "US":
            code = text(row.get("symbol", row.get("代码", ""))).upper()
            code = re.sub(r"^(105|106|107)\.", "", code)
            names = [text(row.get(key, "")) for key in ("cname", "name", "名称")]
        elif market == "HK":
            code = text(row.get("代码", "")).zfill(5)
            names = [text(row.get(key, "")) for key in ("中文名称", "英文名称", "名称")]
        else:
            code = text(row.get("证券代码", row.get("A股代码", ""))).zfill(6)
            names = [text(row.get("证券简称", row.get("A股简称", "")))]
        pattern = r"[A-Z][A-Z0-9.-]{0,19}" if market == "US" else r"\d{5}" if market == "HK" else r"\d{6}"
        names = list(dict.fromkeys(name[:200] for name in names if name))
        if not re.fullmatch(pattern, code) or not names:
            continue
        symbol = market + "." + code
        # Lists are candidates. Futu must confirm identity and STOCK/ETF type on add.
        result[symbol] = dict(symbol=symbol, name=names[0], aliases=names[1:], securityType=0)
    if not result:
        raise ValueError("No valid securities returned; existing cache must be retained")
    return list(result.values())


def fetch(market):
    import akshare as ak
    if market == "US":
        import akshare.stock.stock_us_sina as sina
        # AKShare 1.19.3 still uses HTTP here; the same public endpoint supports HTTPS.
        sina.us_sina_stock_list_url = sina.us_sina_stock_list_url.replace("http://", "https://", 1)
        try:
            frame = ak.get_us_stock_name()
        except Exception:
            frame = ak.stock_us_spot_em()
    elif market == "HK":
        frame = ak.stock_hk_spot()
    elif market == "SH":
        import pandas as pd
        frame = pd.concat([ak.stock_info_sh_name_code(symbol="主板A股"), ak.stock_info_sh_name_code(symbol="科创板")])
    elif market == "SZ":
        frame = ak.stock_info_sz_name_code(symbol="A股列表")
    else:
        frame = ak.stock_info_bj_name_code()
    return {"version": 1, "market": market, "source": "akshare", "akshareVersion": ak.__version__,
            "items": normalize_rows(frame.to_dict("records"), market)}


def configure_network():
    # Only affects this short-lived worker. AKShare's many pages need bounded requests/retries.
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    original_init = requests.Session.__init__
    original_request = requests.Session.request

    def init(session, *args, **kwargs):
        original_init(session, *args, **kwargs)
        for scheme in ("http://", "https://"):
            session.mount(scheme, HTTPAdapter(max_retries=Retry(total=2, backoff_factor=0.5,
                status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET", "POST"])))

    def request(session, *args, **kwargs):
        kwargs.setdefault("timeout", (10, 30))
        return original_request(session, *args, **kwargs)

    requests.Session.__init__ = init
    requests.Session.request = request
    # Reuse TLS connections for hundreds of AKShare pagination requests.
    session = requests.Session()
    requests.get = session.get
    requests.post = session.post


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", choices=["HK", "US", "SH", "SZ", "BJ"], required=True)
    args = parser.parse_args()
    try:
        configure_network()
        with contextlib.redirect_stdout(sys.stderr):
            payload = fetch(args.market)
        print(json.dumps(payload, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        # Do not echo request URLs, proxy credentials or full third-party tracebacks.
        print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
