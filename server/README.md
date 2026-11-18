# VideoAdGuard 自建缓存服务

自建后端：API 与 Cloudflare Worker 版完全对齐，作为插件云端缓存的第二后端（双写 + 兜底读），规避 Cloudflare 免费层限额（KV 写 1000 次/天是主要瓶颈）。

## 架构

```
插件客户端
├── 写：自有服务器 + Cloudflare 并行双写（任一成功即成功）
└── 读：自有服务器优先 → 失败/未命中 → Cloudflare 兜底
```

- 自有服务器不可用时，插件行为自动退化为「仅 Cloudflare」，不影响使用
- 两边数据通过双写保持最终一致；切换标准的旧记录靠 criteriaVersion 自动失效，无需迁移

## API（与 Worker 完全一致）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cache/:bvid` | 查询广告缓存（仅返回 accurate 记录） |
| POST | `/api/cache` | 保存/更新广告缓存 |
| GET | `/api/ai-script/:bvid` | 查询 AI 感评分 |
| POST | `/api/ai-script` | 保存/更新 AI 感评分 |
| POST | `/api/batch` | 批量查询（首页卡片标注，上限 30 个 BV 号） |
| GET | `/` | 健康检查（探活用） |

## 部署

### 方式一：直接运行（使用 Node.js 22 或 24）

```bash
cd server
npm ci
npm run build      # 编译到 dist/
PORT=8787 DB_PATH=/var/lib/videoadguard/cache.sqlite3 npm start
```

可用 [videoadguard-cache.service](videoadguard-cache.service) 交给 systemd 托管。服务从 `/opt/videoadguard-cache` 读取 `bin/node`、`dist/` 和 `node_modules/`，SQLite 数据保存在 `/var/lib/videoadguard-cache`。

### 方式二：Docker

```bash
cd server
docker build -t videoadguard-cache .
docker run -d --name videoadguard-cache -p 8787:8787 -v /var/lib/videoadguard:/data videoadguard-cache
```

### HTTPS（必须）

B 站页面是 HTTPS，浏览器会拦截 HTTPS 页面发出的 HTTP 请求（mixed content），所以这个服务必须挂 HTTPS。推荐用 Caddy 自动签证书：

```
cache.你的域名.xyz {
    reverse_proxy 127.0.0.1:8787
}
```

## 启用双写

部署完成后，把地址填进 `src/services/cloud-cache.ts`：

```ts
const SELF_HOSTED_API_URL = 'https://cache.你的域名.xyz';
```

重新构建插件（`npm run build:chrome`）即可。留空时插件只用 Cloudflare，与旧版行为一致。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `./data/cache.sqlite3` | SQLite 数据库文件路径（目录自动创建） |

## 数据

SQLite 单表 KV 结构（key → JSON），记录格式与 Cloudflare KV 完全相同。如果以后要把 Cloudflare 上的存量数据搬过来，直接把 KV 导出的 JSON 按 key 写入 `kv` 表即可。
