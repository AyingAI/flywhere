# 飞哪里 Radar

固定日期，从一个出发地反向比较全国目的地的机票雷达。

## 启动

需要已安装 Node.js 与 `flyai-cli`。

```bash
npm i -g @fly-ai/flyai-cli
node server.js
```

打开 `http://localhost:4173`，先在顶部紧凑查询栏设置出发地、日期、行程与人数；查询完成后可在地图和列表之间切换。右上角“运行设置”用于配置飞猪 API Key，并选择一种 AI 通道：

- API Key：配置 OpenAI 兼容接口地址、Key 和模型。
- 本地 CLI：自动检测 Codex CLI、Claude Code、Gemini CLI，使用已有的本地登录授权调用 AI。

设置保存在仅本机可读的 `.flymap-config.json`（权限 `0600`，已加入 `.gitignore`），密钥不会通过设置查询接口返回浏览器。原有 `.env` 配置仍可作为默认值使用。

## 价格口径

服务端分别查询去程和回程航班，按目的地选择一组可配对航班，并按照以下逻辑计算：

```text
全员总价 =（去程票面价 + 回程票面价 + 去程费用 + 回程费用）× 成人数量
```

如果 FlyAI 返回费用字段，则优先使用接口费用；当前接口返回样例没有独立的燃油/机建字段，因此使用可配置的预算兜底：

```text
机场建设费 50 元 + 燃油附加费 60 元 = 110 元 / 人 / 航段
```

页面会明确标记费用来源为“接口”或“预估”。这用于预算比较，不替代飞猪下单页的最终结算价。

## 接口

- `POST /api/search`：真实查询并返回已筛选、配对、排序的结果
- `GET /api/settings`：返回脱敏后的配置与本地 CLI 状态
- `POST /api/settings`：保存本地运行配置
- `POST /api/ai-rank`：通过 API Key 或已授权的本地 CLI 执行 AI 排序
- `GET /api/china-map`：代理并缓存国内地图边界数据
- `GET /vendor/echarts.min.js`：同源提供地图可视化运行时，避免浏览器直接访问外部 CDN
- `GET /api/fee-policy`：返回当前费用兜底规则

API key 只由本地 Node 服务读取，不发送到浏览器端。
