# AGENTS.md — dsh-web-open-access

本文件给后续接手维护本插件的 agent 看:当前项目**怎么实现**、**哪些是不可破坏的不变量**、**DSH 升级后如何跟随**。动手前先读「不变量与红线」一节。

## 1. 项目是什么

一个 DSH「插件」(bundle 之外,实为一个**同名替换 npm 包**),安装后:

- **认证放开**:删除 `dsh web` 的启动 token、签名 cookie、`/api` 的 401 与 403 Host/Origin 信任篱笆;启动行不再打印 `?token=`;
- **远程 == localhost**:远程浏览器也能用设置(读写并持久化到宿主)、权限预设、欢迎引导等;
- **绑定 0.0.0.0 不在此插件内**,由 dsh web 自身配置(`$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖 `webserver` 行)。

当前适配 **DSH `0.1.2-rc.1`**(见包内 README「适配版本」)。

## 2. 目录与文件

```
dsh-web-open-access/        # 本身即 npm 包,名为 @deepseek-ai/dsh-client-connection
├── package.json            # 声明 dsh.client(platform web);不是 bundle,无 dsh.bundle
├── lib/
│   ├── index.js            # 宿主半身(自包含):无认证 connection 服务 + /api 路由 + index 注入
│   └── client.js           # 浏览器半身:已安装 DSH 客户端 bundle 的【原样拷贝,禁止修改】
└── README.md / AGENTS.md
```

## 3. 实现原理(为什么这样设计)

### 3.1 为什么是「同名替换包」而不是改配置或改行名

- 认证(token/cookie/篱笆)**硬编码**在 `@deepseek-ai/dsh-client-connection`,无任何开关;
- web 的浏览器模块图有 **15 个 `dsh.client.inject` 边**硬引用包名 `@deepseek-ai/dsh-client-connection`,且客户端内核 `import()` 对缺失图条目**抛错**——因此图里必须保留 id 为该名字的条目;
- 结论:不能删行、不能把行的 `name` 换成别的包。唯一干净做法是**安装一个声明同名 `@deepseek-ai/dsh-client-connection` 的包**,靠 Node 模块解析「从 profile 目录上溯、profile 本地优先」劫持该行的加载(安装原件在 `$DSH_HOME/profiles/node_modules` 的 fallback 农场里,层级更靠后)。

### 3.2 宿主半身 `lib/index.js`

- **自包含**:绝不能用 `import ... from '@deepseek-ai/dsh-client-connection'` —— 包名解析回自己,死循环/TDZ。所有依赖(RPC 信封校验、`node:http↔fetch` bridge、`/api` shared handler)都是按原版移植的手写实现(MIT)。
- 提供与原件**同名、同调用面**的 `connection` 服务(下游 `web-app` / `frontend-static` / `api-gateway` / `file-upload` / `session-log-export` 通过 `ctx.connection` 取用,无感知):
  - `requestRejection()` → `undefined`(无 403 篱笆、无 401 cookie);
  - `authorizeIndex()` → `true`(首页不查 token);
  - `authenticatedUrl()` → 去掉 `?token=` 的干净 URL;
  - `rpc.handle/intercept`、`fetch.register`、`createSharedFetchHandler(API_PATH)` 与原件语义一致;
  - `/api` 前缀路由照常注册,内部 bridge 与原件一致(buffered/streaming 两种 body 模式、`413`、背压写回、连接断开 abort)。
- **index 注入 `ownsHost`**:在 `apply()` 里订阅 `webserver/index-inject`,推一条 `{ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } }`,渲染为 `<head>` 里的 `<script>globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}</script>`。

### 3.3 浏览器半身 `lib/client.js` —— 为什么必须存在、又为什么不能改

- connection 行同时是该包的浏览器条目(`dsh.client` 声明 + `exports["./client"]`);**不提供浏览器半身,客户端就没有 `ctx.connection`,整个前端起不来**;
- 它逐字节拷贝自安装里的原件,`__DSH_BOOT_READY__` 时序详见下;
- `ownsHost` 的强制**只能走宿主注入,不能改这个文件**:保持「与安装版 diff = 0」是可审计的升级跟随基线。

### 3.4 时序契约(远程 == localhost 成立的关键)

原厂浏览器代码在 `apply` 时一次性计算 `isLoopback`:

```js
isLoopback = transport.ownsHost === true || pageLocation 是 loopback || 非浏览器
```

- 局域网访问 → hostname 是 LAN IP → `isLoopback=false` → 客户端自行禁用设置/持久化等特权面;
- 该值无法从外部覆写,所以必须在**客户端激活之前**置好 `globalThis.__DSH_TRANSPORT__`;
- 保证机制:网页 index 的 head 里跑完我们注入的 `<script>`,然后文档末尾 `__DSH_BOOT_READY__` 才 resolve,**客户端内核 await 它之后才激活插件** → 我们的脚本必然先于 Connection 客户端 `apply` 执行;
- `createWebConnectionRpc(undefined, undefined)` 因无 fetch hook 回落页面原生 `fetch`,行为不变。

## 4. 不变量与红线(动代码前必读)

1. **不改 DSH 源码/已安装包**;所有改动收敛在本插件目录。
2. **不改 connection 行的 `name`/id**;`id: connection` 与包名 `@deepseek-ai/dsh-client-connection` 是客户端模块图的硬约束。
3. **不改 `lib/client.js`**(保持与安装版逐字节一致);`ownsHost` 一律走 `webserver/index-inject` 宿主注入。
4. **宿主半身不得 import 自身包名**(自解析死锁);新逻辑全部自包含。
5. **`connection` 服务调用面必须与原件一致**:新增/改名方法会导致下游(`gateway`、`frontend-static` 等)在运行时拿不到 → 静默失败或启动报错。改前先 grep 已安装包里的调用点。
6. **`__DSH_BOOT_READY__` / index 注入时序契约**若被 DSH 改变(例如客户端改为不等待就激活),`isLoopback` 门控会失效——升级核对项之一。
7. **绑定 0.0.0.0 不在插件里**;`--host 0.0.0.0` 被 `web-startup` 有意拦截,只能走 profile 配置(`$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖 `webserver` 行 config)。
8. 安全:本插件移除全部认证;配 0.0.0.0 后 RCE 面暴露给网络。属于预期行为,不是 bug。

## 5. 安装 / 卸载(与 README 一致)

```bash
# 安装:cd 到插件根目录(即 npm 包本体),用 $PWD 作为路径,不写死绝对路径
cd /path/to/dsh-web-open-access
dsh plugin --profile web add "$PWD"
# 再把 webserver 覆盖追加到 $DSH_HOME/profiles/web/cordis.patch.yml(host: '0.0.0.0')
# 重启 dsh web
# 卸载
dsh plugin --profile web remove @deepseek-ai/dsh-client-connection
# 并移除 profile patch 里的 webserver 覆盖,重启
```

profile 里是 `link:` 依赖 → **修改插件文件无需重装**,重启即生效。

## 6. 跟随 DSH 升级的完整流程

目标:让插件与新版 DSH 的浏览器 bundle 和服务调用面保持同步。**每台机器执行;升级前先备份插件目录。**

```bash
# 0) 确认新版本与变化
dsh --version
# SRC 从全局 npm 根推导,不写死机器路径(global 安装均适用)
SRC="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js"

# 1) diff 浏览器半身;只要超过 0 行差异就必须重建
diff "$SRC" lib/client.js
#    有差异 → cp "$SRC" lib/client.js(保持逐字节一致,不含我们任何改动)
```

### 6.1 升级核对清单(按序)

1. **浏览器半身**:按上重建 `lib/client.js`;`diff "$SRC" lib/client.js` 应为空。
2. **客户端内核/模块图契约**:
   - 确认新版本里 `dsh.client` 声明与 15 个 `dsh.client.inject` 边仍指向包名 `@deepseek-ai/dsh-client-connection`(grep 安装包里所有 `packages/*/*/package.json` 的 `dsh.client.inject/external`);
   - 确认模块扫描仍按「行 → 包 manifest 名」生成图条目、客户端内核 `import()` 缺失仍会抛错;若机制变了需重估「同名替换」策略。
3. **`connection` 宿主服务调用面**:对已安装的 `@deepseek-ai/dsh-client-connection/lib/index.js` 与 `lib/index.js` 做导出对比(应含 `apply/inject/name/API_PATH/HostConnectionService/...`);再 grep 新版 host 消费者(`api-gateway`、`frontend-static`、`web-app`、`file-upload`、`session-log-export` 等)对 `ctx.connection.*` 的调用,凡新版调用的方法必须能在我们的 `HostConnectionService` 上找到,行为一致。
4. **信封/RPC 协议**:新版的 `clientRequestSchema` 校验字段若变化,需同步宿主半身的手写解析(`type/rpcId/method/payload`,以及 `rpcId`/`method` 必须是 string);检查 `bridge` 的 body 模式、`413`、streaming 语义是否有变。
5. **index 注入机制**:确认 `webserver/index-inject` 事件名、`global` 行渲染、以及「文档末尾 `__DSH_BOOT_READY__` 才 resolve、客户端 await 后再激活」三个不变式仍成立;任一变 → `ownsHost` 注入可能失效,需换注入时机。
6. **绑定侧**:确认 `web-startup` 仍拦截 `--host 0.0.0.0`、webserver schema 仍接受 `host: '0.0.0.0'`;profile patch 无需改,但如果 schema 收紧要随动。
7. **更新文档**:README「适配版本」、本文档的版本基线。

### 6.2 升级后验证(端到端)

```bash
dsh --profile web --dump-config            # webserver.host == 0.0.0.0;connection 行仍在
diff "$SRC" lib/client.js                  # 应为空
# 重启 dsh web 后:
curl -s http://127.0.0.1:3080/ | grep __DSH_TRANSPORT__   # 应看到 ownsHost 注入脚本
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/things -H 'content-type: application/json' -d '{}'  # 不是 401/403
# settings describe(原「限回环」接口)应 ok:true、writable:true
curl -s -X POST http://127.0.0.1:3080/api/settings/describe -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"p","method":"settings/describe","payload":{"args":{}}}'
# 浏览器(局域网 IP):页面加载、可对话、设置可读写并持久化
```

### 6.3 常见升级失败点与修法

| 症状 | 大概率原因 | 修法 |
|---|---|---|
| 页面启动失败/控制台 `cannot resolve` | DSH 改了客户端内核或模块图(6.1-2) | 重估替换包策略,必要时升级注入方式 |
| 对话/生成 RPC 校验错 | 信封 schema 或流协议变了(6.1-4) | 同步宿主半身手写解析/bridge |
| 设置面空白/不持久 | `isLoopback` 门控失效(6.1-5) | 检查 `__DSH_BOOT_READY__` 时序与注入行 |
| 某个下游功能报「connection 无此方法」 | 新 DSH 给 connection 加了方法(6.1-3) | 在 `HostConnectionService` 补实现 |
| `--host 0.0.0.0` 失效 | webserver schema 收紧(6.1-6) | 同步 profile patch |

## 7. 快速自检(改完代码后)

```bash
node --check lib/index.js
diff <安装的 client.js> lib/client.js        # 必须为空
# 机制级验证(无需重启):用真实 webserver 包渲染注入行
node --input-type=module -e '
  const { createRequire } = require("node:module").createRequire;'
```
(完整机制级验证脚本见仓库维护记录;核心断言:以真实 `@deepseek-ai/dsh-host-webserver/lib/index.js` 的 `renderIndexInjections` 渲染 `lib/index.js` 推的 `global` 行,产物必须含 `globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}`。)
