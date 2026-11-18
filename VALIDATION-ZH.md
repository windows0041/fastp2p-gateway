# C 网关验证

以下命令从网关仓库根目录运行。基础构建和 CTest 命令见 [README](README.md#构建)。

`sudo bash scripts/check.sh --sanitize` 构建并执行 CTest，再在隔离网络中验证认证、JWT、TLS、TCP/UDP NAT、WSS 分片、连接协调、管理请求、容量、超时、SQLite 持久化及重启恢复。网络测试需要 Linux 网络命名空间和 `ip` 命令。可用 `FASTP2P_C_GATEWAY_BUILD_DIR` 指定网关构建目录，默认是 `build/`。

`sudo bash scripts/integration.sh` 使用六个真实 C 客户端验证 TCP 打洞、QUIC、TCP/UDP 转发、心跳和网关重启。它默认从相邻的 [fastp2p 客户端仓库](https://github.com/windows0041/fastp2p) 运行 `tests/integration.py` 并使用其中的 `build/fastp2p`。可用 `FASTP2P_CLIENT_SOURCE_DIR` 和 `FASTP2P_C_BUILD_DIR` 指定客户端源码和构建目录。

`tests/dualstack_integration.py` 验证 IPv4/IPv6 双栈：仅 v6 登录与观测族、双栈 families 上报、按族 NAT 等级（含 6/9 通道）、`user_version` 5→6 迁移保留旧行、5/0 中继族硬过滤与 5/1 `family`、每族 NAT 探测端口与 SPEC §3 的 `[v6]:port` 回显、以及 v6 来源的登录限速与 v4 预算隔离。全部用回环 `::1`/`127.0.0.1` 完成，不依赖公网 IPv6。

`sudo bash scripts/check-registry.sh` 验证主机名、数字补齐、重名隔离、稳定身份、SQLite 崩溃恢复以及使用规范节点名的 TCP/QUIC 转发。使用与 `scripts/integration.sh` 相同的客户端构建目录。

`tests/web_ui.py` 使用临时网关和模拟节点验证登录、安装 Token、搜索分页、节点详情、规则操作、权限与移动屏幕。在 Python 虚拟环境中安装 Playwright 后运行以下命令。首次在 Linux 上安装 Chromium 时可加 `--with-deps` 补齐系统依赖。

```sh
python3 -m playwright install chromium
python3 tests/web_ui.py --gateway build/fastp2p-gateway --output build/web-ui
```

旧部署记录保存在 Git 历史，新协议部署结果以实际验证为准。

账号/删除集成测试覆盖自定义账号、错误当前密码、旧会话和延迟请求撤销、重启持久化、哈希存储、在线删除拒绝、离线删除和设备再次登记。浏览器测试覆盖账号修改重登、离线删除确认与列表刷新。

生产部署版本、实机测试、管理入口及发布记录见 [2026-11-02 部署验收](DEPLOYMENT-ZH.md)。
