# VideoAdGuard 自建缓存服务

自建后端提供共享检测缓存和人工文案标注。检测缓存与 Cloudflare Worker 共用接口，人工标注由自建服务统一写入。

## 架构

```
检测缓存
├── 写：自有服务器 + Cloudflare 并行双写（任一成功即成功）
└── 读：自有服务器优先 → 失败/未命中 → Cloudflare 兜底
```

- 自有服务器不可用时，检测缓存继续使用 Cloudflare
- 两边数据通过双写保持最终一致；切换标准的旧记录靠 criteriaVersion 自动失效，无需迁移

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cache/:bvid` | 查询广告缓存（仅返回 accurate 记录） |
| POST | `/api/cache` | 保存/更新广告缓存 |
| GET | `/api/ai-script/:bvid` | 查询 AI 感评分，已有人工标注时附带 `aiScriptLabel` |
| POST | `/api/ai-script` | 保存/更新 AI 感评分 |
| POST | `/api/ai-script-label` | 提交 `{ bvid, isAiScript }`，后一次人工提交覆盖前一次 |
| GET | `/api/ai-comment-blocklist` | 返回已进入共享名单的 UID |
| POST | `/api/ai-comment-blocklist` | 提交 `{ uid }`，首次有效请求立即发布该 UID |
| POST | `/api/batch` | 批量查询（首页卡片标注，上限 30 个 BV 号） |
| GET | `/` | 健康检查（探活用） |

## 部署

### 方式一：直接运行（使用 Node.js 22 或 24）

```bash
cd server
npm ci
npm run build      # 编译到 dist/
PORT=8787 DB_PATH=/var/lib/videoadguard/cache.lmdb npm start
```

可用 [videoadguard-cache.service](videoadguard-cache.service) 交给 systemd 托管。服务监听 `127.0.0.1:8787`，供同一台机器上的反向代理访问。服务从 `/opt/videoadguard-cache` 读取 `bin/node`、`dist/` 和 `node_modules/`，LMDB 数据保存在 `/var/lib/videoadguard-cache/cache.lmdb/`。

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
| `CACHE_BIND_ADDRESS` | 系统默认 | 监听地址；systemd 服务使用 `127.0.0.1` |
| `DB_PATH` | `./data/cache.lmdb` | LMDB 数据目录（启动时自动创建） |

## 数据

LMDB 将视频键和 JSON 文本保存在本地，记录格式与 Cloudflare KV 相同。

### 从 SQLite 升级

新部署可直接启动。已有 SQLite 数据时，先用 Node.js 22.13+ 或 24 安装新版本依赖并编译，再停掉旧服务，确保导入期间旧库没有新写入。按 systemd 默认路径执行导入。

```bash
node dist/migrate-sqlite.js /var/lib/videoadguard-cache/cache.sqlite3 /var/lib/videoadguard-cache/cache.lmdb
```

导入命令会输出记录数。旧 SQLite 库以只读方式打开，目标 LMDB 库需要为空。若以 root 导入，把新目录及其文件的所有者设为服务状态目录的所有者。

```bash
chown -R --reference=/var/lib/videoadguard-cache/ /var/lib/videoadguard-cache/cache.lmdb
```

然后部署新版的 `dist/` 和 `node_modules/`、安装新版 systemd 服务配置并重启。Docker 部署可在同一个数据卷里指定旧文件和新目录。
