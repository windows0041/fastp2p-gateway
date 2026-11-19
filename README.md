# fastp2p C 网关

Linux C11 网关提供 HTTPS/WSS、NAT 探测、连接协调、中继候选选择、Web 和 SQLite。与 fastp2p 2.x 客户端配套，协议 `fastp2p2`。数据通过客户端之间的 QUIC 或 TCP 隧道传输；只有打洞不可用时才经第三节点中继，且中继看不到明文。

## Release 下载加速

同步优先读取 GitHub 的 `releases/latest`。如果它没有指向有效的客户端正式版，网关从版本列表中选择版本号最高的 `fastp2p-client-vX.Y.Z` 正式版。

在环境文件中设置 `FASTP2P_RELEASE_DOWNLOAD_PREFIX=https://gh-proxy.org/`，控制台同步时会优先通过该加速入口查询版本信息和下载公开 Release 文件。下载内容需与 API 元数据和校验清单中的大小、SHA-256 一致，加速异常时尝试直连官方 API。加速请求直接连接加速站。该配置下元数据和文件都由加速站转发，摘要校验验证下载一致性，发布者身份仍依赖这条获取链路。

## 构建

以下源码构建命令均从本仓库根目录运行。网关的构建目标是 Linux，Windows 上可使用 WSL。

静态构建（推荐，产出一个不依赖发行版运行库的可执行文件）：

```sh
bash scripts/build-static.sh x86_64
```

> 双栈注意：静态构建现在以 `-DLWS_IPV6=ON` 编译 libwebsockets，静态包同样支持 `--bind6`/`--apibind6`。若使用系统库构建（Debian 的 `libwebsockets-dev` 默认 `-DLWS_IPV6=ON`）行为一致。

本地开发也可以直接链接系统库（Debian 12/13）：

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config python3 \
  libwebsockets-dev libjson-c-dev libssl-dev libsqlite3-dev
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

## 部署

```sh
bash scripts/tls/generate-cert.sh /private/tls gateway.example.com 127.0.0.1
```

发行压缩包中的证书脚本位于 `scripts/generate-cert.sh`，网关程序位于 `bin/fastp2p-gateway`。

复制 `.env.example` 到私有环境文件，配置强管理密码、16 位数字接入 Token（首位非零）、证书和数据库路径。`FASTP2P_PUBLIC_HOST` 必须是客户端可达、且出现在服务器证书 SAN 中的地址。`FASTP2P_CA_FILE` 指向公开 CA，用于专用客户端的公开信任配置；公有 CA 可省略并使用客户端系统信任库。

加载私有环境变量后启动：

```sh
build/fastp2p-gateway --bind 0.0.0.0 --apibind 127.0.0.1
```

从源码部署并使用控制台的 GitHub 版本同步时，先执行 `cmake --install build --prefix /opt/fastp2p`，再启动 `/opt/fastp2p/bin/fastp2p-gateway`。安装会把同步脚本放在网关程序旁边。

IPv6 双栈按需追加参数，每族独立监听、互不影响；不给 `--bind6` 时行为与纯 IPv4 版本完全一致：

```sh
build/fastp2p-gateway --bind 0.0.0.0 --bind6 :: --apibind 127.0.0.1 --altwss6 443
```

`--bind6`/`--apibind6` 接受 IPv6 字面量（`::`、`::1`、`2001:db8::1`）。WSS、API 与可选 alt WSS 各自再开一个 v6 vhost，NAT 探测端口（TCP 27180–27181、UDP 27180–27183）也按族各绑一套。`FASTP2P_PUBLIC_HOST` 或 `--public-host` 写成 v6 字面量时，升级下载 URL、安装脚本与控制台预设会自动加方括号。

默认 WSS TCP 27183；TCP NAT 27180–27181；UDP NAT 27180–27183；Web/API HTTPS 127.0.0.1:10008。远程管理通过 SSH 转发访问。Web 可查看在线/离线节点、搜索分页、转发规则和安装 Token。中继候选排除两个端点本身、对称 NAT 节点、协议主版本不同的节点，以及不能覆盖两端公共地址族的节点（v4-only 中继永不会被选给 v6 端点对），并按最久未使用优先分配；客户端最多同时中继 4 条会话，超限即拒绝加入，端点随即改用其他候选。

SQLite 使用回滚日志和同步写入，文件权限 0600；通过 SQLite 在线备份接口备份。旧 C 数据库可以保留记录升级 application_id；回退旧程序前应恢复升级前数据库快照。

Docker 从仓库根目录构建：

```sh
docker build -t fastp2p-gateway:local .
```

挂载 TLS 证书、公开 CA 及可写 `/var/lib/fastp2p`，设置相同环境变量。容器管理端的宿主机映射只绑定回环地址。systemd 示例见 `deploy/fastp2p-c-gateway.service`。

## 管理账号与节点删除

首次启动使用 FASTP2P_USER / FASTP2P_PASSWORD 初始化管理账号；可自行指定，不使用固定默认账号密码。之后以 SQLite 中保存的账号为准，修改环境变量不会覆盖已保存的设置。

控制台开放邮箱注册。用户填写邮箱和至少 8 位的密码后即可登录，无需邮箱验证码。邮箱登录不区分大小写，注册后可修改密码。每个账号有独立的设备、转发规则和安装 Token，安装包由管理员统一维护。`a16673997618@gmail.com` 默认保留为现有管理员的登录邮箱，可通过 `FASTP2P_ADMIN_EMAIL` 配置。邮箱与原有账号名均可使用原密码登录，现有设备及安装 Token 归管理员账号。

在侧栏打开“我”，点击“修改账号与密码”。需要输入当前密码，新密码至少 8 位。设置以 PBKDF2-SHA256 加盐哈希保存，修改后旧管理会话失效，需重新登录；客户端接入 Token 与连接保持不变。

忘记密码时，先停止网关服务，设置新的 FASTP2P_USER / FASTP2P_PASSWORD，携带原有证书、Token 与数据库配置运行 fastp2p-gateway --reset-admin，然后重启服务。此操作重置管理账号，不删除节点或轮换客户端 Token。

离线节点的操作列提供“删除”，确认后移除 SQLite 登记记录及名称保留；在线节点不能删除。删除记录不撤销安装 Token，仍持有有效 Token 的设备再次上线会重新登记。

在设备详情的「设备名字」旁点击「改名」。新名字须包含 8–31 个字母、数字、下划线或连字符，且在该网关上未被其他设备使用。保存后在线设备短暂断开，重新连接时采用新名字。网关会更新该账号内引用旧名字的转发规则。手工配置节点名的设备需要先升级到支持改名的客户端，并连接一次网关。

数据库核心 schema 版本为 `PRAGMA user_version=9`。启动时自动迁移，原有设备、规则和 Token 归现有管理员。版本 9 增加独立用户账号、设备归属和设备旧名记录。升级前备份数据库，回退旧版网关时使用相应的数据库快照。

同步 GitHub 最新稳定客户端成功后，清理较低版本的镜像包和手动上传包，保留相同或更高版本。正在下载或已下发升级的版本暂缓清理，后台每分钟重试过期租约和删除失败项。同步失败时保留现有包。

登录后打开「安装客户端」。Windows 在 PowerShell 运行复制的命令，按提示确认管理员权限。Linux 命令用 `wget` 下载脚本并执行，Mac 命令用 `curl`，在当前登录用户的终端执行。每条命令使用 10 分钟内有效的一次性 HTTPS 链接，可在安装页重新生成。Android 用户在手机上点「下载 APK」，安装后回到此页点「打开 FastP2P 并接入」。

Linux 提供通用 shell 安装脚本 `GET /api/v1/update/install?platform=linux`。脚本含有可用包的版本、长度、SHA-256、网关地址、公开 CA 和服务脚本，执行时自动识别 CPU，通过网关的公开 WSS 端口下载对应程序。下载程序需要 curl 或启用 TLS 的 GNU wget。MIPS 用户空间检测使用 `dd`。一次性链接下载的 Linux 和 Mac 脚本在响应中携带本账号的 Token，命令用私有临时文件保存脚本，运行结束后清理。手动下载的脚本仍从文件名取 Token，共享缓存不保存 Token。下载器用私有配置文件传递 `Authorization: FastP2P <Token>`，下载端点保留旧客户端的 query Token 兼容。客户端远程升级接口仍提供原始可执行文件。已清理旧包时需重新下载脚本。修改安装脚本后须重新构建网关（Docker 构建上下文使用仓库根目录）。

专用客户端包通过 [客户端仓库的 `common/bootstrap.json`](https://github.com/windows0041/fastp2p/blob/main/common/bootstrap.json) 预置网关地址和公开 CA，用户只需输入 16 位数字 Token。更换服务器 CA 或地址后需要重新构建专用客户端。

默认 Linux 安装脚本使用最近一次成功同步的版本及更新的包。官方客户端当前提供 x86_64、aarch64、armv7、riscv64 和 mips64el。缺少本机架构时，脚本会列出可用架构并在改动服务前退出。

「安装客户端 → Mac」提供一个通用脚本，接口为 `GET /api/v1/update/install?platform=macos`。支持 macOS 13 及以上，自动选择 Apple Silicon `arm64` 或 Intel `x86_64`。保留下载文件名，在已登录 macOS 桌面的当前用户终端中执行 `sh ./fastp2p-macos-<16位数字>.sh`，无需 sudo。网关生成的脚本固定下载时的安装包版本、长度、SHA-256 和公开 CA。客户端验证网关后保留已有身份和配置，并注册用户级 LaunchAgent，随登录启动。带版本的原始包下载和远程升级继续按架构提供。

网关 2.0.7 内置的 Linux 安装脚本在新程序验证启动成功后清理历史程序副本，保留配置、证书和诊断日志。客户端 2.0.5 同时处理远程升级后的旧可执行文件及已退出升级进程留下的临时程序；安装失败仍保留回滚所需文件。

## 客户端配置下发

控制台的手动字段配置对话框已移除：`/api/v1/device/<节点名>/config` 现在返回 410，操作员不能再向节点提交任意 JSON。转发规则与 SOCKS5 入口仍由网关数据库托管，并通过同一份版本化期望状态（main 3 sub 19）在下发、停用与删除时同步到在线客户端；离线客户端在下次连接后收到。`node_configs` 表继续记录期望状态、版本与确认结果，删除离线节点同样清理其规则及下发配置。
