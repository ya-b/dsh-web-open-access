# dsh-web-open-access

DSH 插件:放开 `dsh web` 的**认证**限制, 和 **0.0.0.0** 的远程访问限制。

- 🔓 **认证放开**:删除启动 token、签名 cookie、`/api` 的 401 与 403 Host/Origin 信任篱笆,启动行不再打印 `?token=`;
- 🖥️ **远程 == localhost**:浏览器端强制"页面拥有本机"语义,解除 `isLoopback` 门控——远程页面也能使用设置(读写并持久化到宿主)、权限预设、欢迎引导等;

> ⚠️ **安全警告**:安装本插件后认证完全关闭;若再按下文把绑定配成 `0.0.0.0`,web 界面(可执行 shell/文件工具)对任何能到达该主机的网络可达——完全暴露 RCE。**仅限可信网络。** 移除插件并重启后恢复出厂安全行为。

## 结构

```
dsh-web-open-access/                   # 本身即 npm 包 @deepseek-ai/dsh-client-connection
├── package.json                       # 作为 profile 普通依赖安装（非 bundle 层）
├── lib/
│   ├── index.js                       # 自包含宿主半身：无认证 connection 服务 + /api 路由 + index 注入 ownsHost
│   └── client.js                      # 原厂浏览器半身的原样拷贝（与安装版逐字节一致，未修改）
└── README.md
```

## 适配版本

本插件针对并验证于 **DSH `0.1.2-rc.1`**(`dsh --version` 查看):

- `lib/client.js` 逐字节取自该版本安装里的 `@deepseek-ai/dsh-client-connection@0.1.2-rc.1/lib/client.js`;
- `lib/index.js` 按该版本 connection 服务的公开调用面(`requestRejection` / `authorizeIndex` / `authenticatedUrl` / `rpc.intercept` / `fetch.register` / `createSharedFetchHandler` / `/api` 路由与 bridge 语义)编写。

同 `0.1.x` 小版本内大概率可用,但**契约以 0.1.2-rc.1 为准**。DSH 升级后按文末「重新构建浏览器半身」重新拷贝 `lib/client.js`,并对照新版核对 `lib/index.js` 的服务面,再验证(免 token、0.0.0.0、设置可读写)。

## 绑定配置(dsh web 自身,非插件)

`--host 0.0.0.0` 被 `web-startup` 有意拦截(`program.error: ... for safety`),所以绑定必须走 profile 配置层。在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加:

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

## 安装

用 `dsh plugin` 命令把整个插件目录装进 web profile:

```bash
dsh plugin --profile web add github:ya-b/dsh-web-open-access
```

再把上面的 webserver 配置追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`(绑定 0.0.0.0,见「绑定配置」)。

安装后**重启** `dsh web`(依赖变动不走 patch 热重载;profile patch 变化在 live 重载范围内)。

验证:

```bash
dsh --profile web --dump-config          # webserver.host == 0.0.0.0（来自 profile 层）
dsh web                                  # 启动行无 ?token=，并打印 (LAN: http://<ip>:<port>)
ss -ltnp | grep 3080                     # 0.0.0.0:3080
# 另一台机器浏览器访问 http://<主机局域网IP>:3080 —— 免密、设置可读写并持久化
```

## 卸载

```bash
dsh plugin --profile web remove @deepseek-ai/dsh-client-connection
# 并从 $DSH_HOME/profiles/web/cordis.patch.yml 删除 webserver 覆盖(或改回 host: '127.0.0.1')
# 重启后恢复：仅 127.0.0.1 + token/401/403 完整安全行为
```

## 为什么这样设计(机制说明)

- **认证**:token/cookie/篱笆全部硬编码在 `@deepseek-ai/dsh-client-connection`,无开关。web 的浏览器模块图(15 个 `dsh.client.inject` 边)要求图里存在 id 为 `@deepseek-ai/dsh-client-connection` 的条目,所以不能简单换行名——而是**同名安装替换包**:loader 从 profile 优先解析该名字到我们的包,宿主半身不再认证,浏览器半身仍是原厂 transport。
- **远程 == localhost**:`lib/client.js` **与安装版逐字节一致,不加任何字节**。改由宿主半身在 `webserver/index-inject` 事件里推一条 `global` 行,把 `<script>globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}</script>` 渲染进 index 的 `<head>`;浏览器内核在文档末尾的 `__DSH_BOOT_READY__` 后才激活插件,所以该脚本必然先于 Connection 客户端 `apply` 执行 → `ctx.connection.isLoopback` 恒为 true,解除设置/持久化/权限预设等"限回环"门控。`createWebConnectionRpc(undefined, undefined)` 回落页面原生 fetch,行为不变。

## 已知边界

- **版本耦合**:本插件适配 DSH `0.1.2-rc.1`(见「适配版本」);DSH 升级后需重新构建 `lib/client.js` 并核对 `lib/index.js` 服务面。
- **目录选择器**:绑 0.0.0.0 后 `directory-picker-auto` 自动退回浏览器 `browse` 后端(原生 OS 选择器在远程场景不适用),不影响功能。
- **`--host`/`--trusted-host` flag**:`--host 0.0.0.0` 被 web-startup 拒绝;绑定改由 profile 配置决定。认证关闭后 `--trusted-host` 亦无意义(篱笆已移除)。
