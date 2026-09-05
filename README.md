# 飞哪里 FlyWhere

> 根据票价，决定飞哪里。

[![License: MIT](https://img.shields.io/badge/License-MIT-365346.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-365346.svg)](https://nodejs.org/)

![飞哪里 FlyWhere：通过航线雷达、价格票签和登机牌探索低价目的地](assets/flywhere-cover.jpg)

飞哪里是一个本地运行的机票探索工具。固定出发与回程日期后，它会查询真实航班，把不同目的地的往返组合、全员总价、飞行时间与天气放在同一张地图和列表里，帮助你回答：**这次哪里便宜，值得飞？**

## 桌面应用

桌面版已经内置 Node.js 运行环境与 FlyAI 航班查询组件。普通用户不需要安装 Node、npm、Git 或使用终端。

### macOS

1. 打开 `FlyWhere-版本-universal.dmg`。
2. 把“飞哪里 FlyWhere”拖入“应用程序”。

### Windows

1. 打开 `FlyWhere-版本-x64.exe`。
2. 按安装向导选择目录并完成安装。

### 首次使用

1. 前往飞猪 AI 开放平台获取 API Key，粘贴并保存。
2. 选择日期，直接搜索低价目的地。

桌面版设置保存在当前用户的系统数据目录：macOS 是 `~/Library/Application Support/飞哪里 FlyWhere/`，Windows 是 `%APPDATA%/飞哪里 FlyWhere/`。飞猪与 AI API Key 使用 Electron `safeStorage` 加密后落盘，查询记录仍只保存在本机。

### 构建安装包

macOS：

```bash
npm install

# 当前 Apple Silicon Mac 的测试包
npm run make:mac

# 同时支持 Intel 与 Apple Silicon 的单一安装包
npm run make:mac:universal
```

Windows：

```bash
npm install
npm run make:win
```

产物位于 `out/`。未配置 Apple Developer 证书时会生成未签名测试包；正式对外发布时设置以下环境变量后重新构建：

```bash
export APPLE_TEAM_ID="你的 Team ID"
export APPLE_ID="你的 Apple ID"
export APPLE_APP_PASSWORD="App 专用密码"
npm run make:mac:universal
```

构建脚本会使用 Developer ID 签名并提交 Apple 公证。不要把证书、密码或这些环境变量提交到仓库。

## 核心能力

- **全国探索**：以价格优先发现目的地，不只重复推荐热门城市。
- **真实往返组合**：分别查询去程和回程，允许两程使用不同航司。
- **透明价格**：同时展示票面价、机建燃油费和全员总价。
- **地图与列表**：地图看距离与分布，列表比较具体航司、时刻和中转。
- **本地查询记录**：恢复历史结果不会重复请求上游接口。
- **天气辅助判断**：行程进入可靠预报窗口时展示目的地天气。
- **可选 AI 建议**：AI 解释“优先考虑、最省钱、少折腾”的取舍，但不会筛选或改动价格排序；建议会随查询记录保存在本地。

## 快速开始

### 环境要求

- [Node.js 20+](https://nodejs.org/)
- 一个从[飞猪 AI 开放平台](https://flyai.open.fliggy.com/)申请的 API Key

### 安装与启动

```bash
git clone https://github.com/AyingAI/flywhere.git
cd flywhere
npm start
```

打开 <http://127.0.0.1:4173>，点击右上角“运行设置”：

1. 点击“一键安装”安装本机航班查询组件；也可以手动执行 `npm install -g @fly-ai/flyai-cli`。
2. 填写自己的飞猪 API Key 并保存。
3. 回到首页选择日期，点击“搜索低价目的地”。

项目默认只监听 `127.0.0.1`，不会直接暴露到局域网或公网。

## AI 建议（可选）

航班搜索本身不依赖 AI。需要 AI 建议时，可任选一种方式：

- **OpenAI 兼容 API**：填写接口地址、API Key，获取模型列表后选择模型。
- **本地 CLI 授权**：使用已经登录的 Codex、Claude Code、Gemini CLI、Pi、Kimi Code 或 OpenCode。

已有建议时，再点击“AI 建议”只会展开本地保存的结论，不会重复调用模型。只有主动选择“重新生成”才会发起新请求；新请求失败时会保留旧建议。

## 价格口径

```text
全员总价 =（去程票面价 + 回程票面价 + 去程费用 + 回程费用）× 成人数量
```

费用遵循以下优先级：

1. FlyAI 返回明确费用时，使用接口值。
2. 接口没有费用明细时，按每个航段的大圆距离估算：
   - 800 公里及以内：机场建设费 50 元 + 燃油附加费 40 元。
   - 800 公里以上：机场建设费 50 元 + 燃油附加费 70 元。

页面会标注费用来源。调整人数只在浏览器本地重算，不会再次查询航班。最终价格、余票和适用规则仍以飞猪下单页为准。

## 本地数据与外部请求

| 数据或请求 | 用途 | 保存位置 |
| --- | --- | --- |
| `.flymap-config.json` | 网页版飞猪与 AI 设置 | 项目目录，仅本机，权限 `0600`，已被 Git 忽略 |
| macOS Application Support + Keychain | 桌面版设置与加密后的 API Key | 当前 Mac 用户目录 |
| 浏览器 `localStorage` | 查询记录、AI 建议、已去过标记 | 当前浏览器 |
| 飞猪 AI 开放平台 | 查询真实航班 | 由 FlyAI CLI 请求 |
| Open-Meteo | 天气与地理编码 | 不保存个人身份信息 |
| 阿里云 DataV | 中国地图边界 | 服务端缓存 |
| jsDelivr | ECharts 运行时 | 服务端缓存 |
| Gitee | 产品 Logo 源文件 | 服务端代理并缓存 |
| 你配置的 AI 服务或本地 CLI | 生成可选建议 | 仅在主动请求时调用 |

服务端会复用相同条件的短期航班快照，浏览器保存最近 12 条成功查询，以减少等待和上游限流。

## 安全边界

- 密钥不会返回给浏览器明文，设置界面只显示掩码。
- `.env`、`.flymap-config.json`、本地 Agent 文件和调试产物均在 `.gitignore` 中。
- 当前没有账号、鉴权和多用户隔离，**不要直接把本服务部署到公网**。
- 如果把 `HOST` 改成 `0.0.0.0`，同一网络中的其他设备也可能访问查询与设置接口。

详细说明和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm run check
```

网页版仍保持轻量：前端位于 `index.html`，本地服务与外部能力适配位于 `server.js`。桌面入口位于 `desktop/main.js`，DMG 配置位于 `electron-builder.config.js`。

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。当前主要在 macOS 与 Node.js 20+ 环境验证，其他平台的问题与改进欢迎提交 Issue。

## 项目限制

- 这是目的地决策与航班比较工具，不负责登录、占座或下单。
- 航班完整度和实时性取决于 FlyAI 与上游数据。
- 天气只在可用预报窗口内显示；超出窗口时不展示占位数据。
- 全国探索会尽量合并找到的可用组合，但不能承诺覆盖所有机场和所有库存。
- 当前交互地图用于本地产品探索。若将地图页面公开部署或用于商业传播，应改用依法审核的地图并按规定标注审图号；仓库封面刻意不使用任何国土轮廓。

## 许可证与声明

代码和仓库内自有资源采用 [MIT License](LICENSE)。

飞哪里 FlyWhere 是独立开源项目，并非飞猪官方产品，也未获得飞猪、OpenAI 或其他第三方服务的背书。相关名称、商标、接口和数据归各自权利人所有；使用第三方服务时，请同时遵守其服务条款与数据政策。
