# 中转站可用性检测器

一个**纯前端**网页工具：输入 OpenAI 兼容中转站（one-api / new-api 类）的 **Base URL** 和 **API Key**，一键查看

1. **可用模型列表**（`GET /v1/models`）
2. **每个模型的实际连通性**（发一条最短 chat 请求，看通/不通 + 延迟）
3. **额度使用情况**（总额 / 已用 / 剩余）

所有请求都在**你的浏览器内**直接发往中转站，**API Key 不经过任何服务器**（包括托管本页的服务器）。可部署到任意静态托管（GitHub Pages / Cloudflare Pages / Vercel 等）。

## 用法

1. 打开页面，填入 Base URL（如 `https://api.example.com`，**不带** `/v1`）和 API Key。
2. 点 **检测**：显示站点类型（one-api / new-api）、额度卡、模型列表。
3. 模型列表里（**按供应商自动分组**，如 OpenAI / Anthropic / DeepSeek / 智谱 GLM / 通义千问…，每组可点标题折叠）：
   - 点单行 **测试** 探活该模型；
   - 点某组的 **测试该组** 只测该供应商的全部模型；
   - 点 **测试全部** 批量探活（默认 5 路并发，可随时 **停止**）；
   - 用搜索框过滤、用下拉按状态/延迟排序；组标题右侧显示该组 `总数 · ✓通 ⚠告警 ✗失败` 统计。
4. **记住到本地**（可选）：勾选后把 Base URL / Key 存进浏览器 `localStorage`（仅本机本浏览器）。公共电脑请勿勾选。

### 模型状态含义

| 颜色 | 含义 |
|---|---|
| 🟢 绿 `✓ 123ms` | 连通，括号为往返延迟 |
| 🟡 黄 `⚠ 4xx ...` | 站点可达，但该模型有问题（无权限 / 模型不存在 / 参数不兼容 / 限流等） |
| 🔴 红 `✗ ...` | 不通（网络 / CORS / 5xx） |

> 连通性测试发的是 `max_tokens: 16`、内容为 `"Hi"` 的最短请求。**推理型模型**（gpt-5.x / o 系列等）在极小预算下可能「没说完就到上限」返回 `400 ... max_tokens`——这其实证明模型已连通，工具会**判定为绿色**。而 `404 deployment does not exist`（站点未上架该模型）和 `400 operation unsupported`（codex / 图像等模型不走聊天接口）仍显示为黄色（确实不可用 / 接口不匹配）。

## ⚠️ 关于 CORS（重要）

本工具是纯静态网页，没有浏览器扩展那种跨域豁免，因此浏览器能否直连中转站**取决于该站是否开启 CORS**（返回 `Access-Control-Allow-Origin`）。

- 多数 **one-api / new-api** 默认开启 CORS（`*`），可直接使用。
- 若某站**未开启 CORS**，浏览器会拦截请求，页面显示「无法直连：可能该站未开启 CORS……」。这属于该中转站的配置限制，本工具按设计**不做任何服务器端代理**（以保证 Key 不外泄）。

额度接口走 one-api / new-api 的 OpenAI 兼容查询：

```
GET {base}/v1/dashboard/billing/subscription   -> hard_limit_usd   总额度(USD)
GET {base}/v1/dashboard/billing/usage?...        -> total_usage      已用(美分)
剩余 = 总额度 - 已用
```

字段映射在 `api.js` 的 `normalizeTotal()`，站点字段不同时改这一处即可。

## 本地运行

ES module 不能用 `file://` 直接打开，需起个静态服务：

```bash
cd relay-checker
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 部署

纯静态，无需构建、无需后端：

- **GitHub Pages**：把本目录推到仓库，仓库 Settings → Pages 选分支即可。
- **Cloudflare Pages / Vercel / Netlify**：新建项目指向本目录，构建命令留空、输出目录设为根目录。

## 文件结构

```
relay-checker/
├── index.html   # 单页结构（暗色「诊断仪表台」UI）
├── styles.css   # 样式：Chakra Petch + JetBrains Mono，青绿信号主色，网格/噪点底纹
├── api.js       # fetch 层：detectStation / listModels / testModel / fetchQuota
├── app.js       # UI 逻辑：检测、供应商分组渲染、分组/并发测试、localStorage
└── README.md
```

## 隐私

- Key 仅用于直接请求你填的中转站，不发往别处。
- 「记住」功能存的是浏览器本地 `localStorage`，可随时取消勾选清除。
- 无任何分析 / 埋点脚本。界面字体引用 Google Fonts（仅样式与字体文件，非追踪脚本）；介意可改 `index.html` 顶部的 `<link>` 改用系统字体。
