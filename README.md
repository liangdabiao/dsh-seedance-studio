# 上美影短剧工坊（dsh-seedance-studio）

把 [smy-seedance-storyboard](https://github.com/) 这套「上美影风格短剧」skill 搬进 DeepSeek Harness，并接上**即梦官方 CLI（dreamina-canvas）**：
一句话故事 → 剧本 / 色盘 / 资产图 / 每集 15 秒分镜 → 在即梦画布上出图出片 → 拼成一部片，全程不用离开对话；
每次生成都进「生成历史」，花了多少积分、出了什么、哪张失败都查得到。

<img width="2397" height="1212" alt="image" src="https://github.com/user-attachments/assets/a470ed4d-d4c4-49ac-b80b-b31c0a84c6bc" />

## 装了什么

| 能力 | 说明 |
|---|---|
| skill `smy-seedance-storyboard` | 随包快照：SKILL.md + 6 篇 references + 2 个示例项目，`/skill` 和模型都能用 |
| `seedance_studio` | 建项目、读进度、登记资产/分镜；即梦登录、查积分、建画布 |
| `jimeng_asset` | 每个资产在画布上建图片节点 → 等待生成 → 下载到 `assets/` |
| `jimeng_episode` | 每集建视频节点（m2v，资产节点作参考）→ 等待 → 下载到 `videos/` |
| `seedance_assemble` | ffmpeg 把各集拼成 `out/final.mp4`，可选贴旁白音轨 |
| `seedance_history` | 查生成历史：列表 / 单条详情 / 积分汇总 / 清空 |
| 侧栏「短剧工坊」 | 工作台：概览 · 我的短剧 · 生成历史 · 新建短剧 · 文-资-视-剪 |

## 前置

即梦官方 CLI（带 OAuth 登录、画布、积分审批，和 npm 上的第三方 `jimeng-cli` 不是一回事）：

```powershell
irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex
dreamina-canvas --format json version
```

装完让模型跑 `seedance_studio action=login` 拿授权链接，扫码后 `action=login-check`。
拼接还需要 `ffmpeg`。

## 项目目录

```
<项目目录>/
  project.json      # 工具读写：色盘、画幅、画布 id、资产表、每集分镜与视频状态
  剧本.md  素材清单.md  E01_分镜.md …
  assets/           # C01.png S01.png …
  videos/           # E01.mp4 …
  out/              # final.mp4
```

生成会复用同一张即梦画布，`project.json` 里记着画布 id 和每个节点的 nodeId，随时能回画布继续改。

## 侧栏工作台（布局对齐「投资尽调」）

装好后侧栏多一个「短剧工坊」，主区域是一个完整页面：

| 页面 | 内容 |
|---|---|
| 概览 | 在做的短剧 / 资产图 / 已出片集 / 累计积分 / 生成次数；即梦登录状态与积分；最近项目、最近生成 |
| 我的短剧 | 项目卡（封面、画幅、色盘、资产与分集进度）；可换扫描目录、搜索 |
| 项目详情 | 资产墙（点图看大图、看 prompt 与积分）、分集（内嵌播放、重出本集）、这个项目的生成记录、出图/出片/拼接按钮 |
| 生成历史 | 每次生成一条：时间、类型、项目、摘要、积分、成功/失败；可按类型/状态/项目/关键词筛，点开看动了哪些对象、产物路径、错误原文 |
| 新建短剧 | 填剧名、集数、秒数、画幅、风格、色盘、故事梗概 → 打开新对话并带上「文-资-视-剪」全流程指令 |
| 文-资-视-剪 | 四步工作流、模型报价表、项目目录结构、常见问题 |

页面按钮和工具走同一套代码：路径校验、积分上限（图片 10 / 视频 100）、错误文案完全一致；
点「新建短剧 / 在对话里继续」不会自动发消息，只是把写好的指令填进新对话的输入框。

**生成历史存在哪**：`$DSH_HOME/seedance-studio/history.json`（默认 `C:\Users\<你>\.dsh\seedance-studio\`），
页面和 `seedance_history` 工具读的是同一份；`settings.json` 记着页面用过的扫描目录。历史最多保留 400 条，只删记录不动产物。

首次装好或改了 `client.js` 后刷新一次页面（Ctrl+R）；**改了 Host 半边（`lib/`、`index.js`）需要重启一次 DeepSeek Harness**
（宿主的热更新不监听 `node_modules` 里的链接插件）——会话记录不受影响。

## 典型流程

1. `seedance_studio action=env`：CLI、登录、积分、模型一次看清
2. `action=init` → 写剧本/素材清单/分镜 → `action=update` 登记 assets 与 episodes
3. `jimeng_asset action=generate`（可先 `dryRun: true`）
4. `jimeng_episode action=generate`
5. `seedance_assemble` → `out/final.mp4`
6. `seedance_history action=stats`：总共花了多少积分

## 限制与费用

实测报价（2026-11，cn 区）：

| 用途 | 模型 · 参数 | 积分 |
|---|---|---|
| 资产图 | `seedream_4.5` · 2K | 约 3/张 |
| 单集 15s | `seedance_2.0_mini` · 720p | 约 90 |
| 单集 15s | `seedance_2.0_fast_vip` · 720p | 约 90 |
| 单集 15s | `seedance_2.5_draft` · 480p | 约 135 |
| 单集 15s | `seedance_2.5` · 720p | 约 300 |

- 生成消耗即梦积分；`maxCredits` 是单次上限（图片默认 10、视频默认 100），报价超过上限直接拒绝，不会静默扣费。
- 默认模型选的是便宜档（`seedream_4.5` + `seedance_2.0_mini`），验证分镜够用；要质量再换 `seedance_2.5`。
- Seedance 单集 15 秒、参考图最多 9 张；模型与分辨率以 `model list` 实时结果为准。
- 出片是慢操作：一个视频节点通常几分钟，工具会等终态再下载。
- 即梦会在产物左上角打「AI生成」水印，这是平台行为，CLI 侧去不掉。

## 自检

```powershell
node scripts/api-test.mjs     # 起本地 http，打一遍 catalog / project / history / 静态页面（不花积分）
node scripts/client-smoke.mjs # 浏览器半边能否被 __ModuleLoader__ 接住、两个 slot 都注册
node scripts/selftest.mjs     # 数据层 + CLI 探活 + ffmpeg 拼接（不建节点、不花积分）
```

`api-test.mjs` 会把 `$DSH_HOME` 指到 `.tmp/` 下的临时目录，不碰你的真实历史。

## 安装

```bash
dsh plugin --profile web add dsh-seedance-studio
```

## 许可

插件代码是 MIT（见 `LICENSE`）。`skills/smy-seedance-storyboard` 是第三方内容快照，原仓库未附 LICENSE，
随包携带仅限本地自用；对外分发或商用前请先向原作者确认授权，详见 `skills/NOTICE.md`。

特别致谢社区支持：  https://linux.do
