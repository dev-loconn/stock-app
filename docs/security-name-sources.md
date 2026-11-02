# 证券搜索名称资料

当前开发版目录从 AKShare 获取；0.4.0 和已发布的 0.5.0 使用 OpenD 的记录保留在历史验证文档中。本地缓存只保留完整代码、主要名称、来源返回的中英文别名及待核验类型，不保留抓取到的报价或账号资料。

| 市场 | AKShare 接口 | 上游 |
| --- | --- | --- |
| 港股 | `stock_hk_spot()` | 新浪港股，抽取代码、中英文名 |
| 美股 | `get_us_stock_name()`，失败时 `stock_us_spot_em()` | 新浪中英文名单；备用东方财富名单 |
| 沪股 | `stock_info_sh_name_code()` 主板A股与科创板 | 上交所 |
| 深股 | `stock_info_sz_name_code("A股列表")` | 深交所 |
| 北交所 | `stock_info_bj_name_code()` | 北交所 |

接口依据：[AKShare 股票文档](https://akshare.akfamily.xyz/data/stock/stock.html)。固定 AKShare 1.19.3；0.6.10 起便携包内置于 `resources/app/runtime/python`，开发环境使用项目内 `.cache/akshare-venv`，可用 `STOCK_BAR_PYTHON` 指定解释器。同步脚本 `scripts/akshare-directory.py` 每次读取一个市场；非美市场串行，美股独立分页，最多两个子进程，单市场十分钟超时，退出应用会取消剩余同步。新浪美股在该 AKShare 版本仍使用 HTTP，本项目改用同一公开接口的 HTTPS 地址；分页复用连接、增加有限重试及单请求超时，不改写数据内容。东方财富备用返回的 105/106/107 前缀仅用于来源标识，映射时删除该前缀并保留完整美股 symbol。

沪深京名单按交易所来源映射，不靠代码首位猜测市场。港股补齐五位、A 股补齐六位；美股保留完整代码中的点或连字符，不自行改写类别股。所有结果经富途 `stock-basicinfo` 再核验后才加入自选，不能解析的代码不会被替换成相近证券。目录类型 0 表示尚未核验，只有富途确认的类型 3/4（股票/ETF）可以保存为自选。沪深京普通股票名单不代表 ETF 或历史退市名单全覆盖。

云端行情使用 `stock-basicinfo` → `market-state` / `stock-quote` 及 WebSocket；报价缺失时按缺失代码回退到[官方快照](https://open.futunn.com/zh-cn/api/quote/realtime/market-snapshot)。最新[报价文档](https://open.futunn.com/zh-cn/api/quote/realtime/stock-quote)和[市场状态文档](https://open.futunn.com/zh-cn/api/quote/basic-data/market-state)列有 BJ 前缀；实际以账号权限与接口返回为准。本地 OpenD 备用模式未扩展 BJ，包含 BJ 自选时切换到 OpenD 会给出说明。

应用包含以下人工核对的少量名称别名，只在对应代码已经存在于有效目录时参与搜索，不生成虚构证券或跨市场合并条目。

| 完整代码 | 补充名称 | 一手依据 |
| --- | --- | --- |
| HK.00700 | 腾讯、腾讯控股、Tencent、Tencent Holdings | [腾讯中文投资者关系](https://www.tencent.com/zh-cn/investors/)、[英文投资者关系](https://www.tencent.com/Investors/) |
| US.AAPL | 苹果、Apple、Apple Inc. | [Apple IR FAQ](https://investor.apple.com/faq/)、[Apple 中文官方文件](https://www.apple.com.cn/legal/ifu/CN-ecg-2-ifu.pdf) |
| HK.09988、US.BABA | 阿里巴巴、Alibaba、Alibaba Group | [中文投资者 FAQ](https://www.alibabagroup.com/zh-HK/faqs-investor-information)、[英文投资者 FAQ](https://www.alibabagroup.com/en-US/faqs-investor-information) |
| US.NVDA | 英伟达、NVIDIA | [NVIDIA IR FAQ](https://investor.nvidia.com/investor-resources/faqs/default.aspx)、[NVIDIA 中文官方新闻](https://www.nvidia.com/content/dam/en-zz/en_sg/news/%E4%BF%83%E8%BF%9B%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E7%A0%94%E7%A9%B6%E5%92%8C%E6%95%99%E8%82%B2-%E9%A9%AC%E6%9D%A5%E8%A5%BF%E4%BA%9A%E8%AF%BA%E4%B8%81%E6%B1%89%E5%A4%A7%E5%AD%A6%E6%90%AD%E4%B8%8A%E8%8B%B1%E4%BC%9F%E8%BE%BE-DGX-A100-%E5%88%97%E8%BD%A6.pdf) |

首字母从目录名称、来源别名及上述中文别名生成，简繁转换使用固定版本 opencc-js 1.4.2，拼音使用 pinyin-pro 3.29.5。Nasdaq、HKEX 直连名单没有接入；实际数据覆盖以每个市场同步后的计数和时间为准。

用户界面明确提示名称和别名覆盖因证券而异；无别名的证券仍可按实际名称或代码搜索。目录遗漏时，可用完整代码经当前行情服务核验并添加。排序为精确、前缀、包含，每次返回前 20 条及总匹配数，A 股筛选包含 SH/SZ/BJ。每日后台刷新失败保留旧缓存，空数据或错误市场的响应不会覆盖可用名单。
