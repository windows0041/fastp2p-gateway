#!/bin/sh
# macOS per-user installer. The gateway provides the manifest and public CA.
set -eu
umask 077

fail() { printf '%s\n' "fastp2p: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || fail '请用 sh 加下载文件名执行，无需传入 Token。'
[ "$(uname -s)" = Darwin ] || fail '请在 macOS 上运行此脚本。'
uid=$(id -u)
[ "$uid" -ne 0 ] || fail '请在 Mac 的终端以当前登录用户运行，无需 sudo。'
case "$HOME" in /*) ;; *) fail '找不到当前用户的主目录。' ;; esac

for tool in awk curl cmp mktemp shasum sw_vers sysctl launchctl plutil; do
    command -v "$tool" >/dev/null 2>&1 || fail "缺少必要命令：$tool"
done
release=$(sw_vers -productVersion)
[ "${release%%.*}" -ge 13 ] || fail '需要 macOS 13 或更新版本。'

case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64)
        # A terminal running under Rosetta still installs the native binary.
        arch=x86_64
        if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] ||
           [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
            arch=arm64
        fi
        ;;
    *) fail '暂不支持此 Mac 的 CPU 架构。' ;;
esac
token=''
if [ -z "$token" ]; then
    token=$(printf '%s\n' "${0##*/}" | awk -F '[^0-9]+' '
    { for (i=1;i<=NF;i++) if (length($i)==16 && $i ~ /^[1-9][0-9]*$/) { n++; key=$i } }
    END { if(n==1) print key; else exit 1 }') || fail '文件名必须包含一个有效的 16 位 Token，请从控制台重新下载。'
fi

app=$HOME/Library/Application\ Support/fastp2p
agents=$HOME/Library/LaunchAgents
binary=$app/fastp2p
profile=$app/client.json
plist=$agents/top.fastp2p.plist
domain=gui/$uid
service=$domain/top.fastp2p
lock=$app/.install.lock
locked=false
installing=false
was_loaded=false
work=$(mktemp -d /tmp/fastp2p-macos-install.XXXXXXXX)

rollback() {
    loaded=false
    launchctl print "$service" >/dev/null 2>&1 && loaded=true
    changed=false
    index=0
    for path in "$binary" "$profile" "$plist"; do
        index=$((index + 1))
        backup=$work/previous/$index
        if [ -f "$backup" ]; then
            cmp -s "$backup" "$path" || changed=true
        elif [ -e "$path" ] || [ -L "$path" ]; then
            changed=true
        fi
    done
    if ! $changed && [ "$loaded" = "$was_loaded" ]; then return 0; fi
    if $loaded; then
        launchctl bootout "$service" || return 1
    fi
    index=0
    for path in "$binary" "$profile" "$plist"; do
        index=$((index + 1))
        backup=$work/previous/$index
        if [ -f "$backup" ]; then
            replacement=$(mktemp "$path.restore.XXXXXXXX") || return 1
            if ! cp -p "$backup" "$replacement" || ! mv -f "$replacement" "$path"; then
                rm -f "$replacement"
                return 1
            fi
        else
            rm -f "$path" || return 1
        fi
    done
    if $was_loaded; then launchctl bootstrap "$domain" "$plist" || return 1; fi
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    keep_backup=false
    if [ "$status" -ne 0 ] && $installing; then
        if rollback; then
            printf '%s\n' '已恢复安装前的状态。' >&2
        else
            keep_backup=true
            printf '恢复未完成。安装前的文件保存在 %s/previous\n' "$work" >&2
        fi
    fi
    if $locked; then rmdir "$lock"; fi
    rm -f "$work/download.conf" "$work/token"
    if ! $keep_backup; then
        case "$work" in /tmp/fastp2p-macos-install.*) rm -rf "$work" ;; esac
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

@@FASTP2P_DOWNLOAD@@
launchctl print "$domain" >/dev/null 2>&1 || fail '请登录 macOS 桌面，在终端中运行此脚本。'
url=$gateway_url/api/v1/update/download?platform=$package_platform\&version=$expected_version
printf '%s\n' "正在下载 $arch 客户端 $expected_version…"
printf 'header = "Authorization: FastP2P %s"\n' "$token" > "$work/download.conf"
if [ "$download_ca" -eq 1 ]; then
    printf 'cacert = "%s"\n' "$work/gateway-ca.pem" >> "$work/download.conf"
fi
curl -q --config "$work/download.conf" --fail --silent --show-error --noproxy '*' \
    --proto '=https' --connect-timeout 15 --max-time 300 \
    --output "$work/fastp2p" "$url" || fail '下载失败，请检查网络或从控制台重新下载脚本。'
rm -f "$work/download.conf"
[ "$(wc -c < "$work/fastp2p")" -eq "$expected_size" ] || fail '下载长度不符。'
printf '%s  %s\n' "$expected_sha" "$work/fastp2p" | shasum -a 256 -c - >/dev/null ||
    fail '程序 SHA-256 校验失败。'
chmod 700 "$work/fastp2p"
version=$("$work/fastp2p" --version) || fail "客户端无法在 $arch 上运行。"
case "$version" in "fastp2p $expected_version ABI "*) ;; *) fail '安装包版本不符。' ;; esac

[ ! -L "$app" ] && [ ! -L "$agents" ] || fail '配置或登录启动项目录不能是符号链接。'
mkdir -p "$app"
mkdir "$lock" 2>/dev/null || fail "已有安装正在进行，请检查 $lock。"
locked=true
mkdir "$work/previous"
[ ! -L "$plist" ] || fail '登录启动项不能是符号链接。'
if [ -f "$plist" ]; then
    installed_profile=$(plutil -extract ProgramArguments.3 raw -o - "$plist") ||
        fail '无法读取现有登录启动项的配置路径。'
    case "$installed_profile" in /*) profile=$installed_profile ;; *) fail '现有配置路径必须是绝对路径。' ;; esac
fi
[ "$profile" != "$binary" ] && [ "$profile" != "$plist" ] || fail '现有配置路径和安装文件冲突。'
index=0
for path in "$binary" "$profile" "$plist"; do
    index=$((index + 1))
    [ ! -L "$path" ] || fail "安装文件不能是符号链接：$path"
    if [ -e "$path" ]; then
        [ -f "$path" ] || fail "安装路径已被其他类型的文件占用：$path"
        cp -p "$path" "$work/previous/$index"
    fi
done
if launchctl print "$service" >/dev/null 2>&1; then
    [ -f "$plist" ] || fail '已加载的服务缺少 LaunchAgent 文件，无法备份。'
    was_loaded=true
fi

printf '%s' "$token" > "$work/token"
unset token
installing=true
printf '%s\n' '正在验证网关并注册登录启动项…'
FASTP2P_BOOTSTRAP_FILE="$work/gateway.json" "$work/fastp2p" install --token-file "$work/token" --config "$profile" ||
    fail '安装未完成，请查看上方错误。'
launchctl print "$service" >/dev/null 2>&1 || fail '无法确认 LaunchAgent 已注册。'
installing=false
printf 'fastp2p %s 已安装。当前用户登录后会自动启动。\n' "$expected_version"
