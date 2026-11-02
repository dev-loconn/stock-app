# AKShare 证券目录与富途云端行情验收

0.6.10 更新：便携包现已内置隔离 Python/AKShare 环境，修复系统 Python 别名导致的同步失败及 `undefined` 错误详情；当前运行时和真实同步证据见 [运行环境修复](akshare-runtime-validation.md)。下文保留原开发环境验证记录。

日期：2026-10-25（Asia/Shanghai），开发源码验证；原有发布 ZIP 未重打包。

## 实现

- Python 3.12 项目虚拟环境安装 AKShare 1.19.3，Electron 主进程启动同步子进程；目录不依赖富途登录或 OpenD。
- 港股、美股、沪股、深股、北交所分别缓存，支持每日更新、手动刷新和单市场命令行重试。空响应、市场不符、网络错误和超时均保留可用目录；跨进程原子写入与合并避免 CLI、应用互相覆盖。
- 本地索引包含名称、中英文别名、代码、拼音首字母；简繁归一，精确/前缀/包含排序，200ms 防抖，前 20 条加总数；A 股筛选覆盖沪深京。断线可以搜索，添加需要当前行情服务核验。
- 富途云端以 `stock-basicinfo` 核验完整代码及股票/ETF 类型，保存后由既有 REST 和 WebSocket 服务订阅全部自选。报价遗漏时仅对缺失代码请求官方 `snapshot`，标注快照且不猜测实时/延迟属性；快照失败不使其他证券的报价失败。A 股使用 `Asia/Shanghai` 时区；BJ 允许云端核验，本地 OpenD 备用模式给出范围说明。

## 自动验证

- `npm run build`：TypeScript、Vite 和 Windows 原生检测器构建通过。
- Node 24 下完整 Vitest 套件通过；系统 PATH 的 Node 20 低于 package.json 要求，会导致原有 OpenD SDK WebSocket 测试失败，不据此修改 SDK。
- `tests/akshare-directory.test.ts` 与 `tests/security-catalog.test.ts`：8 项通过，含五市场同步、按市场重试、繁简/中英文/拼音/代码搜索、离线重载、失败保留和独立写入者合并。
- `python -m unittest discover -s tests -p test_akshare_directory.py`：3 项通过，覆盖零填充、中英文名称、类别股标点、东财前缀转换、重复和非法记录处理。
- `tests/cloud.test.ts`：8 项通过，新增 A 股快照补齐、快照源时间和上海时区、缺失证券提示、快照失败时保留旧价格且不影响其他证券的检查。
- 原生港美搜索专项通过（`artifacts/search-fixture/result.json`）。
- 原生云端专项通过（`artifacts/cloud-desktop/result.json`）：未登录刷新与名称搜索、A 股筛选、贵州茅台搜索后点击添加、沪深京云端核验与报价、React 绘制新增自选、上海时区、凭证隔离和退出清理。此处使用隔离账号配置与本机协议夹具，价格是测试样本。

## 真实数据与账户边界

五个市场真实同步已完成，逐市场条数和时间记录在 `.cache/security-directory-akshare.json`：

| 市场 | 有效且去重后的候选记录 |
| --- | ---: |
| 港股 | 2,810 |
| 美股 | 18,166 |
| 沪股 | 2,318 |
| 深股 | 2,906 |
| 北交所 | 353 |
| 合计 | 26,553 |

美股新浪源的 HTTP 地址不可用，改用同一接口 HTTPS 后实际完成 917 页下载，历时约 537 秒。来源可能包含不支持的品类、退市或不能被富途识别的代码，候选数不能解释为富途可交易证券数。最终仍由云端身份核验过滤。真实缓存的腾讯、Apple、AAPL、gzmt、payh 搜索及离线重载记录见 `artifacts/akshare-directory-live.json`。

真实富途 `stock-basicinfo` 和 `stock-quote` 的无凭证对照均返回 HTTP 401、`-12006`。Windows 保护的登录在独立验证进程中未能读取；停止旧便携版并启动正式应用上下文后成功恢复原授权，无需用户重新登录。原有 6 只自选均恢复云端报价，五个市场缓存都已进入正式应用。未修改原有自选。

通过正式应用内 `--catalog-cloud-live-check` 执行只读验证，记录为 `artifacts/akshare-cloud-live-authenticated.json`：

- `HK.00700`、`US.AAPL`、`SH.600519`、`SZ.000001`、`BJ.920000` 的基本信息和市场状态均实际返回，基本信息类型均为 STOCK。
- 腾讯、苹果的 `stock-quote` 与 `snapshot` 均返回有效价格。
- 本机账号的沪深京三个样例在 `stock-quote` 与 `snapshot` 中均被省略；接口成功但没有对应条目。原因不能仅据此断定为某一种权限，需由富途确认地区/行情权限/接口范围。应用会逐只显示未返回报价或快照的提示，保留其他证券行情；未把本地夹具的 A 股价格冒充真实账号实测。
- 当前为周末，返回价格不能证明开市持续实时更新。源时间、账户权限和支持范围仍需按实际市场验证。

## 复现

```powershell
npm run setup:akshare
npm run sync:securities
npm run sync:securities -- --market=US
npm run build
npm start
```

正式应用使用 `--catalog-cloud-live-check` 时，在自身授权上下文请求基本信息、市场状态、报价和快照；不改动自选，仅输出标的是否返回及是否有价格，不导出价格或凭证。应用已运行时也可用 `electron . --catalog-cloud-live-check` 发起同一只读检查。

`scripts/check-cloud-catalog.cjs` 另提供普通 Node 入口，可使用进程环境中的 `FUTU_ACCESS_TOKEN`；独立 Electron 的 `--saved-login` 不能保证读取正式应用的加密上下文，应优先使用上述应用内诊断。所有检查均不输出令牌、账户标识、认证头或代理地址。

目录边界及来源详见 [名称资料](security-name-sources.md)。当前 A 股导入普通股票名单，未额外导入 A 股 ETF 名单；完整代码仍可以经富途核验添加。
