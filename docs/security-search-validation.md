# 0.4.0 证券搜索验证

2026-10-24（Asia/Shanghai），Windows x64，Electron 45.0.0、futu-api 10.11.7108、Node.js 24.19.0。用户已最终确认 Q1–Q16 的方案；本次实现范围见 [设计](./design.md)，名称资料覆盖见 [资料说明](./security-name-sources.md)。

## 已实现

- 本地港美证券目录、代码片段/中英文名/拼音首字母匹配、简繁等价、大小写及首尾空格归一化。
- 按市场筛选，完整代码精确匹配优先于前缀、包含匹配，最多展示 20 条并显示总匹配数量。
- 约 200 毫秒输入防抖，方向键选择及回车添加，中文输入法选字保护。
- 结果旁一次点击，经现有 OpenD 证券身份核验后保存；无行情权限不阻止保存，随后标记状态。
- 已添加标记、最多 10 只、自选满额可搜索、成功后保留查询及结果，完整代码后备添加。
- 目录持久化与离线重载，超过一天后台刷新、手动刷新、按市场独立更新、失败保留旧目录。
- 目录查询采用独立的较长接口超时，索引构建分批让出事件循环；不将目录失败当成行情连接失败。

## 检查结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 前端与主进程、Vite、Windows 原生检测器构建 | 通过 | 前端/主进程使用相同构建步骤；正式应用运行时旧检测器被占用，最终检测器直接编译到发布暂存目录，避免中断用户窗口 |
| 常规自动测试 | 45 项通过，3 项需要显式启用的原生检查跳过 | npm test；目录匹配/重载/刷新/损坏、SDK 目录查询、只读旧配置及既有行情/设置/拖拽等 |
| 原生搜索与添加 | 30 项断言通过 | artifacts/search-fixture/result.json，协议夹具、真实 SDK、正式 preload/IPC/React、隔离配置 |
| 原生布局回归 | 28 项断言通过 | artifacts/layout-fixture/result.json，含三只分页、宽度、总览更新、断线保留及 IPC 权限 |
| 独立便携 EXE | 30 项搜索断言通过 | artifacts/search-packaged/result.json，版本 0.4.0，使用包内 Electron 与完整生产依赖 |
| 真实 OpenD 目录与名称覆盖 | 未通过接入前置条件，尚待验证 | artifacts/search-live/progress.json：握手 retType=-1；未取得真实目录，不报告虚构数量或覆盖率 |

目录单元检查覆盖 `700`、`腾讯`、`騰訊`、`Tencent`、`tx` 命中 `HK.00700`，`aapl` 命中 `US.AAPL`，以及 `HK.09988`/`US.BABA` 保持独立、超过 20 条、空输入、失败市场保留、并发刷新与重启离线搜索。

原生检查额外验证真实连接按钮的调用链、未选择时回车无效、中文选字不添加、静态核验失败保留查询、无行情权限证券保留、重复/离线/满额添加被主进程拒绝、只读行情条不能调用设置专用 IPC。原生检查数据全部由协议夹具产生，不属于真实市场行情。

## 截图

- [腾讯首字母搜索](../artifacts/search-fixture/search-tencent.png)
- [单一市场刷新失败仍可搜索](../artifacts/search-fixture/partial-refresh.png)
- [断线搜索与添加禁用](../artifacts/search-fixture/offline-search.png)
- [自选已满仍可搜索](../artifacts/search-fixture/full-watchlist.png)

## 用户报告的连接按钮错误

`window.stockBar.connect is not a function` 已最小复现：用户打开的是 `artifacts/watchlist-ui/main.cjs` 的独立拖拽预览，其模拟 preload 只有 get、onState、setWatchlist、search，缺少 connect。正式 preload 包含 connect，界面按钮能通过 stock:connect 到达主进程；已关闭该临时预览并打开正式应用，将真实连接按钮调用加入原生回归检查。页面首次状态未就绪时禁用连接按钮，避免提前使用默认配置。

该缺少方法错误与实际 OpenD 的握手拒绝是两个不同阶段的问题。后者需要在正式应用中核对 OpenD 登录及 WebSocket 配置；无需把密钥发到聊天。

## 真实数据与资料边界

真实只读诊断使用独立 Electron 配置，读取用户已有的受保护连接，并禁止旧配置迁移回写；诊断目录缓存写在 artifacts/search-live 下，不修改用户自选或连接设置。命令为 `powershell.exe -NoProfile -File scripts/check-search-live.ps1`。当前握手被 OpenD 拒绝，实际全市场目录数量、完整性、首次加载耗时及真实名称覆盖仍待重新验证。

附带的是 5 个证券条目的人工核实名称，不是全市场双语别名库。拼音从已有中文名生成，不含错别字纠正；未接入外部全量数据库。

新增 opencc-js、pinyin-pro 均锁定版本且无新增 npm 审计项；npm audit 仍报告原有 futu-api → protobufjs 依赖链的 1 项 high、1 项 critical，未在本功能中更换现有 SDK。此审计结果不等同于已确认应用中的具体可利用路径。

## 发布记录

0.4.0 Windows x64 ZIP 包含固定依赖、名称资料说明、使用说明及本验证文档。发布包路径为 release/stock-bar-0.4.0-win32-x64.zip，SHA-256 位于同名 .sha256 文件；发布清单位于 release/latest.json。ZIP 解压后使用独立配置重新运行搜索检查，结果记录在 artifacts/search-zip/result.json；暂存目录 EXE 的已通过结果记录在 artifacts/search-packaged/result.json。
