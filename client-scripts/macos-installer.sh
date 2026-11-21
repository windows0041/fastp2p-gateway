#!/bin/sh
# macOS system installer. The gateway provides the manifest and public CA.
set -eu
umask 077

fail() { printf '%s\n' "fastp2p: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || fail '请用 sh 加下载文件名执行，无需传入 Token。'
[ "$(uname -s)" = Darwin ] || fail '请在 macOS 上运行此脚本。'
if [ "$(id -u)" -ne 0 ]; then
    case "$0" in /*) script=$0 ;; *) script=$PWD/$0 ;; esac
    exec sudo -- sh "$script"
fi

for tool in awk curl mktemp shasum sw_vers sysctl launchctl; do
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

prefix=/usr/local/fastp2p
binary=$prefix/fastp2p
config_dir=/etc/fastp2p
profile=$config_dir/config.conf
plist=/Library/LaunchDaemons/top.fastp2p.plist
service=system/top.fastp2p
lock=/var/run/fastp2p-macos-install.lock
locked=false
installing=false
config_created=false
stage=
work=$(mktemp -d /tmp/fastp2p-macos-install.XXXXXXXX)
cleanup() {
    status=$?
    set +e
    if $installing && [ "$status" -ne 0 ]; then
        launchctl bootout "$service" >/dev/null 2>&1
        rm -f -- "$plist" "$binary"
        if $config_created; then rm -f -- "$profile" "$profile.previous" "$profile.identity" "$profile".ca.*.pem; fi
    fi
    if [ -n "$stage" ]; then rm -f -- "$stage/fastp2p"; rmdir "$stage"; fi
    if $installing && [ "$status" -ne 0 ]; then
        rmdir "$prefix" "$config_dir" 2>/dev/null
    fi
    if $locked; then rmdir "$lock"; fi
    case "$work" in /tmp/fastp2p-macos-install.*) rm -rf -- "$work" ;; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$lock" 2>/dev/null || fail '已有安装正在进行。'
locked=true
if [ -e "$plist" ] || [ -L "$plist" ] || [ -e "$binary" ] || [ -L "$binary" ] ||
   launchctl print "$service" >/dev/null 2>&1; then
    fail '请先卸载已有 FastP2P 系统服务。'
fi
@@FASTP2P_DOWNLOAD@@
url=$gateway_url/api/v1/update/download?platform=$package_platform\&version=$expected_version
printf '正在下载 %s 客户端 %s…\n' "$arch" "$expected_version"
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

[ "$("$work/fastp2p" --service-profile)" = "$profile" ] &&
    [ "$("$work/fastp2p" --service-executable 2>/dev/null)" = "$binary" ] ||
    fail '安装包使用旧目录，请先同步新版客户端。'
for path in /usr/local "$prefix" "$config_dir"; do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then mkdir -m 755 "$path"; fi
    [ ! -L "$path" ] && [ -d "$path" ] &&
        ls -ldn "$path" | awk '$3 == 0 && substr($1,6,1) != "w" && substr($1,9,1) != "w" {ok=1} END {exit !ok}' ||
        fail "目录必须由 root 持有且禁止其他用户写入：$path"
done
[ ! -L "$profile" ] || fail '配置不能是符号链接。'
stage=$(mktemp -d "$prefix/.install.XXXXXXXX")
cp "$work/fastp2p" "$stage/fastp2p" && chmod 755 "$stage/fastp2p" || fail '暂存程序失败。'
installing=true
if [ ! -e "$profile" ]; then
    config_created=true
    printf '%s' "$token" > "$work/token"
    FASTP2P_BOOTSTRAP_FILE="$work/gateway.json" "$stage/fastp2p" install \
        --token-file "$work/token" --config "$profile" --no-service || fail '网关校验失败。'
    rm -f "$work/token"
fi
unset token
"$stage/fastp2p" run --config "$profile" --verify-start || fail '客户端启动检查失败。'
mv "$stage/fastp2p" "$binary"
mkdir -p /Library/LaunchDaemons
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>top.fastp2p</string>
    <key>ProgramArguments</key>
    <array>
        <string>$binary</string><string>run</string>
        <string>--config</string><string>$profile</string><string>--background</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
chmod 644 "$plist"
launchctl enable "$service"
launchctl bootstrap system "$plist"
for check in 1 2 3; do
    sleep 1
    launchctl print "$service" | grep -q 'state = running' || fail '系统服务未持续运行。'
done
installing=false
printf 'FastP2P %s 已安装为开机启动的系统服务。\n' "$expected_version"
