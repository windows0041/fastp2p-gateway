'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = {token: '', installToken: '', user: '', email: '', admin: false, installPlatform: 'windows',
    nodes: [], selected: null, apps: [], updates: [],
    refreshing: false, loadingApps: false, selection: 0, editing: null, confirm: null,
    offset: 0, total: 0, registered: 0, upgrades: new Map(), skippedUpgrades: []};
  /* The console keeps its session in sessionStorage: it survives a reload, but
   * it dies with the tab and is never shared with another tab. */
  const STORE = 'fastp2p.console';
  /* Level 5 records a cone-shaped mapping with unmeasured filtering. */
  const udpLevel = node =>
    ({1: 'NAT1', 2: 'NAT2', 3: 'NAT3', 4: 'NAT4', 5: '锥形待判定', 6: '无 NAT', 7: '对称防火墙'}[Number(node.natLevel)] || '未知');
  /* TCP is shown as a mapping observation, never as a NAT level. The probe
   * measures whether the mapping depends on the destination and does not test
   * inbound filtering, so a stable mapping is not full cone: a measured node kept
   * its source port unchanged yet dropped every unsolicited SYN, which reads as
   * NAT3 on UDP. */
  const tcpMapping = value => ({1: '映射稳定', 2: '映射随目标'}[Number(value)] || '未知');
  /* tcpNatLevel is the callback probe's verdict; until it runs the node only
   * reports a mapping observation, so that wording is the fallback. */
  const tcpLabel = node => Number(node.tcpNatLevel)
    ? ({1: 'NAT1', 2: 'NAT2', 3: 'NAT3', 4: 'NAT4'}[Number(node.tcpNatLevel)] || '未知')
    : tcpMapping(node.tcpNatType);
  const natDetail = value =>
    ({1: '映射与目标无关', 2: '对称（端口随机）', 3: '对称（端口递增）', 4: '对称（端口递减）'}[Number(value)] || '探测未完成');
  const hasFamily = (node, bit) => (Number(node.families) || 1) & bit;
  function persist() {
    try {
      if (state.token)
        sessionStorage.setItem(STORE, JSON.stringify({token: state.token, installToken: state.installToken}));
      else
        sessionStorage.removeItem(STORE);
    } catch { /* storage disabled: the console still works for this page view */ }
  }
  function text(id, value) { $(id).textContent = String(value ?? '—'); }
  function element(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function message(value, error = false) {
    text('notice', value); $('notice').hidden = !value; $('notice').classList.toggle('error', error);
  }
  function ruleMessage(value, error = false) {
    text('rule-message', value); $('rule-message').hidden = !value;
    $('rule-message').classList.toggle('error', error);
  }
  function renderAccount(account) {
    state.user = account.user || '';
    state.email = account.email || '';
    state.admin = account.admin === true;
    $('sync-release').hidden = $('upload-update').hidden = !state.admin;
    $('sync-message').hidden = !state.admin;
    renderMinePage();
  }
  function logout(expired = false) {
    state.token = state.installToken = '';
    renderAccount({});
    state.nodes = []; state.apps = []; state.updates = []; state.selected = null;
    state.upgrades.clear(); state.skippedUpgrades = []; renderUpgradeProgress();
    persist();
    state.selection++; $('console').hidden = true; $('login-screen').hidden = false;
    state.offset = state.total = state.registered = 0; $('node-search').value = '';
    $('install-token').value = ''; $('password').value = ''; $('nodes').replaceChildren(); $('rules').replaceChildren();
    $('install-commands').replaceChildren(); delete $('install-commands').dataset.package;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $('login-error').hidden = !expired;
    if (expired) text('login-error', '会话已过期，请重新登录。');
  }
  async function api(path, data, method) {
    const token = state.token, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = {'Content-Type': 'application/json'};
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetch(path, {method: method || (data === undefined ? 'GET' : 'POST'), headers,
        body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
      const raw = await response.text();
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Error('网关返回了无法读取的响应。'); }
      if (response.status === 401) {
        if (token && state.token === token) logout(true);
        throw new Error(token ? '会话已过期，请重新登录。' : '账号或密码不正确。');
      }
      if (!response.ok || body.error) {
        const known = {409: '此节点正在处理另一个查询，请稍后刷新。', 429: '尝试次数过多，请稍后再试。', 503: '节点暂时无法响应，请稍后重试。',
          504: '客户端响应超时，请检查节点是否仍在线。', 501: '此客户端暂不支持该操作。'};
        const details = {'device offline':'节点已离线。','node is online':'节点已上线，不能删除。',
        'client restart unsupported':'此客户端暂不支持远程重启，请先更新客户端。',
          'node not found':'节点记录已不存在。','current password incorrect':'当前密码不正确。',
          'no package for this platform and version':'没有适合此节点平台和架构的安装包，请先手动安装新版客户端。',
          'invalid account settings':'请填写有效账号和至少 8 位的新密码。',
          'invalid email or password':'请输入有效邮箱和至少 8 位的密码。', 'email already registered':'此邮箱已注册，请登录。',
          'invalid node name':'设备名须为 8–31 个字母、数字、下划线或连字符。',
          'node name already in use':'此设备名已被占用，请换一个名字。',
          'client rename unsupported':'请先升级客户端并让设备重新连接。',
          'package not found':'安装包已更新，请刷新后重试。',
          'no supported packages found for this platform':'暂无该平台的安装包。',
          'installation link unavailable':'暂时无法生成安装命令，请稍后重试。'};
        throw new Error(details[body.detail] || known[response.status] || '网关未能完成请求。');
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error('无法连接网关，请检查网络或证书。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  const bytes = value => Number(value) >= 1048576 ? (Number(value) / 1048576).toFixed(1) + ' MiB' :
    Number(value) >= 1024 ? (Number(value) / 1024).toFixed(1) + ' KiB' : Number(value || 0) + ' B';
  function uptime(seconds) {
    const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
    return days ? `${days} 天 ${hours} 时` : hours ? `${hours} 时 ${minutes} 分` : `${minutes} 分`;
  }
  function renderNodes() {
    const query = $('node-search').value.toLowerCase().trim();
    const nodes = state.nodes.filter(n => [n.name, n.hostname, n.ip, n.ipv6, n.lanip, n.os].some(v => String(v || '').toLowerCase().includes(query)));
    $('nodes').replaceChildren();
    for (const n of nodes) {
      const row = element('tr'); row.classList.toggle('selected', n.name === state.selected?.name);
      const cell = element('td'), info = element('div', 'node-cell'), label = element('div');
      info.append(element('span', 'node-avatar', String(n.os).endsWith('-c') ? 'C' : '◇'));
      label.append(element('span', 'node-title', n.name), element('span', 'node-subtitle', n.os || '未知系统'));
      if (n.hostname) label.append(element('span', 'node-subtitle', '主机：' + n.hostname));
      /* SPEC §1: the family badge tells the operator what this node can reach. */
      const v4 = hasFamily(n, 1), v6 = hasFamily(n, 2);
      label.append(element('span', 'node-subtitle', '协议族：' + (v4 && v6 ? 'IPv4 + IPv6' : v6 ? '仅 IPv6' : '仅 IPv4')));
      info.append(label); cell.append(info); row.append(cell);
      const public_cell = element('td', 'mono');
      public_cell.append(document.createTextNode(n.ip || '—'));
      if (n.ipv6) public_cell.append(element('small', 'mono node-subtitle', n.ipv6));
      row.append(public_cell, element('td', 'mono', n.lanip || '—'));
      const nat = element('td');
      /* Only IPv4 is shown: with IPv6 there is normally no NAT to classify, so a
       * second pair of levels would be noise rather than information. */
      nat.append(element('span', '', 'UDP：' + udpLevel(n)),
        element('small', 'node-subtitle', 'TCP：' + tcpLabel(n)));
      nat.title = 'UDP ' + udpLevel(n) +
        '：NAT1 全锥／NAT2 地址受限／NAT3 端口受限／NAT4 对称。' +
        '（映射观测：' + natDetail(n.udpNatType) +
        (n.publicIPPort ? '；TCP 业务端口 ' + n.publicIPPort : '') + '）' +
        'TCP ' + tcpLabel(n) + '：（' +
        (Number(n.tcpNatSamples) || 0) + ' 个样本，' + (Number(n.tcpNatDestinationIPs) || 0) +
        ' 个目标 IP），未做入站过滤探测。' +
        (Number(n.natLevel) === 5 ? ' UDP 已测出锥形映射，入站过滤仍待判定。' : '');
      row.append(nat, element('td', 'mono', n.version || '—'));
      const active = Number(n.isActive) === 1;
      const status = element('td'); status.append(element('span', 'badge ' + (active ? 'online' : 'offline'), active ? '● 在线' : '○ 离线')); row.append(status);
      /* The gateway reports the last heartbeat as a formatted date; an empty value
       * means the node has not been seen since it was registered. */
      const seen = element('td', 'mono');
      seen.append(document.createTextNode(n.activetime ? String(n.activetime) : '—'));
      row.append(seen);
      const action = element('td'), button = element('button', 'link-button', active ? '编辑' : '查看记录');
      button.type = 'button'; button.setAttribute('aria-label', button.textContent + ' ' + n.name);
      button.addEventListener('click', event => { event.stopPropagation(); goToDevice(n.name); });
      action.append(button);
      if (active) {
        const restart = element('button', 'link-button', '重启');
        restart.type = 'button';
        restart.setAttribute('aria-label', '重启 ' + n.name);
        restart.addEventListener('click', event => {
          event.stopPropagation();
          confirm('重启客户端', n.name + ' 将重启，连接会短暂中断。', async () => {
            await api('/api/v1/device/' + encodeURIComponent(n.name) + '/restart', {});
            return '重启指令已发送到 ' + n.name + '。';
          });
        });
        action.append(restart);
      }
      const latest = latestFor(platformForOs(n.os));
      if (active && latest && compareVersions(n.version, latest) < 0) {
        const upgrade = element('button', 'link-button', '升级到 ' + latest); upgrade.type = 'button';
        upgrade.setAttribute('aria-label', '升级节点 ' + n.name + ' 到 ' + latest);
        const pending = state.upgrades.get(n.name);
        if (pending?.status === 'pending') { upgrade.disabled = true; upgrade.textContent = '等待升级完成…'; }
        upgrade.addEventListener('click', event => {
          event.stopPropagation();
          confirm('升级客户端', `${n.name}：${n.version || '未知版本'} → ${latest}。客户端会从网关下载、校验并重启，连接会短暂中断。`, async () => {
            await api('/api/v1/device/' + encodeURIComponent(n.name) + '/upgrade', {version: latest});
            trackUpgrades([{node: n.name, from: n.version, to: latest}], []);
            await new Promise(resolve => setTimeout(resolve, 800));
            await refresh();
            return '升级指令已发送到 ' + n.name + '。';
          });
        });
        action.append(upgrade);
      }
      if (!active) {
        const remove = element('button', 'link-button remove', '删除'); remove.type = 'button';
        remove.setAttribute('aria-label', '删除离线节点 ' + n.name);
        remove.addEventListener('click', event => {
          event.stopPropagation();
          confirm('删除离线节点', `删除 ${n.name} 的登记记录、转发规则和网关下发配置。设备持有接入 Token 时，再次上线会重新登记。`, async () => {
            await api('/api/v1/nodes/' + encodeURIComponent(n.name), undefined, 'DELETE');
            if (state.selected?.name === n.name) selectNode(null);
            state.offset = 0; await refresh();
            return '离线节点已删除。';
          });
        }); action.append(remove);
      }
      row.append(action); row.addEventListener('click', () => goToDevice(n.name));
      $('nodes').append(row);
    }
    text('table-count', state.registered); text('nav-count', state.registered);
    text('search-count', query ? `匹配 ${state.total} / ${state.registered} 个节点` : `共 ${state.registered} 个已登记节点`);
    text('node-page', state.total ? `${state.offset + 1}–${state.offset + state.nodes.length} / ${state.total}` : '0 / 0');
    $('previous-nodes').disabled = !state.offset;
    $('next-nodes').disabled = state.offset + 100 >= state.total;
    $('nodes-empty').hidden = nodes.length > 0;
    const empty = $('nodes-empty');
    empty.querySelector('h3').textContent = query ? '没有匹配的节点' : '还没有登记节点';
    empty.querySelector('p').textContent = query ? '试试其他名称、IP 或系统关键字。' : '让客户端使用此网关的地址、CA 和安装 Token 连接。';
  }
  async function refresh() {
    if (!state.token || state.refreshing) return;
    state.refreshing = true; $('refresh').disabled = true;
    $('previous-nodes').disabled = $('next-nodes').disabled = true;
    const token = state.token, query = $('node-search').value.trim(), offset = state.offset;
    try {
      const [status, devices] = await Promise.all([api('/api/v1/status'),
        api(`/api/v1/nodes?limit=100&offset=${offset}&search=${encodeURIComponent(query)}`)]);
      if (state.token !== token || offset !== state.offset || query !== $('node-search').value.trim()) return;
      text('gateway-label', '网关在线'); $('gateway-status').classList.remove('offline');
      state.nodes = Array.isArray(devices.nodes) ? devices.nodes : [];
      renderUpgradeProgress();
      state.total = Number(devices.total) || 0; state.registered = Number(status.totalNodes) || 0;
      text('online-count', status.online); text('capacity', '/ ' + status.capacity);
      text('uptime', uptime(status.uptimeSeconds)); text('queue', bytes(status.queuedBytes));
      text('queue-limit', '上限 ' + bytes(status.queueLimitBytes)); text('version', status.version);
      text('sidebar-version', 'C Gateway ' + status.version); text('wss-port', 'WSS :' + status.wssPort + ' · HTTPS');
      const wasAdmin = state.admin;
      renderAccount(status);
      if (state.admin && !wasAdmin) syncRelease();
      text('updated-at', '更新于 ' + new Date().toLocaleTimeString('zh-CN', {hour12: false}));
      renderNodes();
      const device = deviceRoute();
      if (device) refreshDevice(device[1]);
      loadUpdates();
    } catch (error) { if (state.token === token) {
      message(error.message, true); text('gateway-label', '连接中断'); $('gateway-status').classList.add('offline');
    } }
    finally {
      state.refreshing = false; $('refresh').disabled = false;
      $('previous-nodes').disabled = !state.offset;
      $('next-nodes').disabled = state.offset + 100 >= state.total;
      if (state.token && (token !== state.token || offset !== state.offset || query !== $('node-search').value.trim())) refresh();
    }
  }
  function selectNode(node) {
    state.selected = node; state.apps = []; state.selection++; state.loadingApps = false;
    const active = node && Number(node.isActive) === 1;
    $('rules').replaceChildren(); $('add-rule').disabled = !active;
    $('refresh-apps').disabled = !active; renderNodes();
    text('selected-name', node ? node.name : '选择一个节点');
    text('selected-description', node ? `${node.hostname || node.os || '未知主机'} · ${node.ip || '—'} · 最近在线 ${node.lastSeen || '—'}` : '在上方节点列表中打开设备，查看它的应用转发。');
    if (active) loadApps();
    else ruleMessage(node ? `节点已离线，登记信息保留在 SQLite 中。首次在线：${node.firstSeen || '—'}；最近离线：${node.lastOffline || '—'}。` : '尚未选择节点。');
  }
  async function loadApps({quiet = false} = {}) {
    if (Number(state.selected?.isActive) !== 1 || state.loadingApps) return;
    const node = state.selected, selection = state.selection;
    state.loadingApps = true; $('refresh-apps').disabled = true;
    if (!quiet) ruleMessage('正在读取网关保存的规则…');
    try {
      const body = await api('/api/v1/device/' + encodeURIComponent(node.name) + '/apps');
      if (selection !== state.selection || !state.token) return;
      const apps = Array.isArray(body.Apps) ? body.Apps : Array.isArray(body.apps) ? body.apps : [];
      if (!quiet || JSON.stringify(state.apps) !== JSON.stringify(apps)) {
        state.apps = apps;
        renderApps();
      }
      ruleMessage(body.TunError || (state.apps.length ? '' : '此节点尚未配置转发规则。'), Boolean(body.TunError));
    } catch (error) { if (selection === state.selection && state.token) ruleMessage(error.message, true); }
    finally { if (selection === state.selection) { state.loadingApps = false; $('refresh-apps').disabled = false; } }
  }
  function renderApps() {
    $('rules').replaceChildren();
    for (const app of state.apps) {
      const row = element('tr'), name = element('td');
      name.append(element('span', 'node-title', app.appName || '未命名规则'));
      if (app.error) name.append(element('span', 'node-subtitle', app.error)); row.append(name);
      const source = element('td'); source.append(element('span', 'badge protocol', String(app.protocol || '').toUpperCase()), document.createTextNode(' :' + app.srcPort)); row.append(source);
      const destination = element('td', 'rule-destination'); destination.append(element('span', '', app.peerNode || '—'),
        element('small', 'mono', app.protocol === 'socks5' ? '动态目标 · SOCKS5' : `${app.dstHost || '—'}:${app.dstPort || '—'}`)); row.append(destination);
      const status = element('td'), enabled = app.enabled === undefined || Number(app.enabled) === 1;
      const connected = enabled && app.linkStatus === 'connected';
      row.append(element('td', 'mono', connected && app.linkMode ? app.linkMode : '—'));
      const label = !enabled ? '已停用' : connected ? '● 已连接' :
        app.linkStatus === 'waiting' ? '等待连接' : '链路待确认';
      const badge = element('span', 'badge ' + (connected ? 'online' : enabled ? 'warning' : 'offline'), label);
      if (connected) badge.title = '与出口节点的加密隧道已建立';
      status.append(badge); row.append(status);
      const actions = element('td');
      if (state.selected.capabilities?.editForward && ['tcp', 'udp', 'socks5'].includes(app.protocol)) {
        const nodeName = state.selected.name;
        const edit = element('button', 'link-button', '编辑'); edit.type = 'button'; edit.addEventListener('click', () => openRule(app)); actions.append(edit);
        const toggle = element('button', 'link-button', enabled ? '停用' : '启用'); toggle.type = 'button';
        toggle.addEventListener('click', () => confirm(`${enabled ? '停用' : '启用'}规则`, `${app.appName || app.srcPort}：${enabled ? '此规则的现有连接将中断。' : '客户端将重新建立转发。'}`, async () => {
          await api('/api/v1/device/' + encodeURIComponent(nodeName) + '/switchapp', {
            appName: app.appName, srcPort: app.srcPort, protocol: app.protocol, peerNode: app.peerNode, enabled: enabled ? 0 : 1});
        })); actions.append(toggle);
        const remove = element('button', 'link-button remove', '删除'); remove.type = 'button';
        remove.addEventListener('click', () => confirm('删除转发规则', `删除 ${app.appName || app.srcPort}，将中断此规则的连接。`, async () => {
          await api('/api/v1/device/' + encodeURIComponent(nodeName) + '/app', {
            appName: app.appName, protocol: app.protocol, srcPort: 0, srcPort0: app.srcPort, protocol0: app.protocol,
            peerNode: app.peerNode, dstHost: app.dstHost, dstPort: app.dstPort, whitelist: app.whitelist || ''});
        })); actions.append(remove);
      } else actions.append(element('span', 'muted', '客户端配置'));
      row.append(actions); $('rules').append(row);
    }
  }
  /* --- Client upgrades ---------------------------------------------------- */
  function trackUpgrades(queued, skipped) {
    for (const item of queued)
      state.upgrades.set(item.node, {...item, started: Date.now(), status: 'pending'});
    state.skippedUpgrades = skipped;
    renderUpgradeProgress(); renderNodes();
  }
  function renderUpgradeProgress() {
    const messages = [];
    for (const [name, item] of state.upgrades) {
      const node = state.nodes.find(n => n.name === name);
      if (node && compareVersions(node.version, item.to) >= 0) item.status = 'complete';
      else if (item.status === 'pending' && Date.now() - item.started > 360000) item.status = 'unconfirmed';
      messages.push(name + '：' + (item.status === 'complete' ? '已升级到 ' + item.to :
        item.status === 'unconfirmed' ? '尚未确认升级完成，请检查客户端日志或手动安装。' :
        '已下发 ' + item.to + '，等待客户端重启并上报新版本…' +
          (String(node?.os || '').startsWith('android') ? '请在手机通知中确认安装。' : '')));
    }
    const reasons = {architecture_not_reported: '旧客户端未上报架构，请先手动安装一次新版。',
      package_unavailable: '没有匹配平台和架构的安装包。', dispatch_failed: '升级指令下发失败，请稍后重试。'};
    for (const item of state.skippedUpgrades)
      messages.push(item.node + '：未下发，' + (reasons[item.reason] || '客户端暂不支持升级。'));
    text('upgrade-message', messages.join('；'));
    $('upgrade-message').hidden = !messages.length;
  }
  function platformForOs(os) {
    const value = String(os || '');
    if (!value.endsWith('-c')) return '';
    if (value.startsWith('windows')) return 'windows';
    if (/^linux-(x86_64|aarch64|armv7|i686|riscv64|s390x|ppc64le|mips64el)-c$/.test(value))
      return value.slice(0, -2);
    if (/^darwin-(arm64|x86_64)-c$/.test(value)) return 'macos' + value.slice(6, -2);
    if (value.startsWith('linux')) return 'linux';
    if (value.startsWith('android')) return 'android';
    if (value.startsWith('darwin')) return 'macos';
    return '';
  }
  function compareVersions(left, right) {
    const a = String(left || '').split('.').map(Number), b = String(right || '').split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  function latestFor(platform) {
    let best = '';
    for (const update of state.updates)
      if ((update.platform === platform || update.platform === platform.split('-')[0]) &&
          (!best || compareVersions(update.version, best) > 0))
        best = update.version;
    return best;
  }
  function availableDownloads() {
    const installers = [];
    for (const [platform, label] of [['linux', 'Linux'], ['macos', 'macOS']]) {
      const packages = state.updates.filter(update =>
        update.platform === platform || update.platform.startsWith(platform + '-'));
      if (packages.length) installers.push({platform, label, automatic: true,
        uploadedAt: Math.max(...packages.map(update => update.uploadedAt || 0))});
    }
    return installers.concat(state.updates.filter(update => !/^(linux|macos)(?:-|$)/.test(update.platform)));
  }
  function renderUpdates() {
    $('updates').replaceChildren();
    for (const update of availableDownloads()) {
      const row = element('tr');
      row.append(element('td', '', update.automatic ? update.label + '（自动识别架构）' : update.platform),
        element('td', 'mono', update.automatic ? '按架构选择最新版' : update.version),
        element('td', 'mono', update.automatic ? '按需下载' : bytes(update.size)),
        element('td', 'mono', update.automatic ? '安装时校验 SHA-256' : String(update.sha256 || '').slice(0, 16) + '…'),
        element('td', 'mono', update.uploadedAt
          ? new Date(update.uploadedAt * 1000).toLocaleString('zh-CN', {hour12: false}) : '—'));
      const cell = element('td', '');
      const button = element('button', 'button', update.automatic ? '下载 ' + update.label + ' 通用安装脚本' : '下载安装包');
      button.type = 'button';
      button.addEventListener('click', () => downloadInstaller(update, button));
      cell.append(button);
      row.append(cell);
      $('updates').append(row);
    }
    $('update-message').classList.remove('error');
    text('update-message', state.updates.length ? '' : '尚无安装包。');
  }
  async function downloadInstaller(update, button) {
    const token = state.token;
    button.disabled = true;
    try {
      const params = new URLSearchParams({platform: update.platform});
      if (!update.automatic) params.set('version', update.version);
      const response = await fetch('/api/v1/update/install?' + params, {
        headers: {Authorization: 'Bearer ' + token}, cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer'});
      if (response.status === 401 && state.token === token) logout(true);
      if (!response.ok) throw new Error('下载安装包失败，请刷新列表后重试。');
      const filename = /filename="([A-Za-z0-9_.-]+)"/i.exec(response.headers.get('Content-Disposition') || '');
      if (!filename) throw new Error('网关未返回安装包文件名。');
      const blob = await response.blob();
      if (state.token !== token) return;
      const url = URL.createObjectURL(blob);
      const link = element('a', '');
      link.href = url;
      link.download = filename[1];
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (update.platform === 'android') text('update-message', '安装 APK 后，请在手机浏览器点「打开 FastP2P 并接入」。');
      else if (update.platform.startsWith('linux')) text('update-message', '执行 sh ' + filename[1] + '（也可用 bash）。脚本自动识别 CPU，从本网关下载对应程序，保留节点身份与配置，安装到 /usr/local/fastp2p 并设置开机启动。需要 curl 或 GNU wget，请勿修改文件名中的 Token。');
      else if (update.platform === 'macos') text('update-message', '在 Mac 的终端执行 sh ' + filename[1] + '。脚本会自动选择 Apple Silicon 或 Intel 版本，保留节点身份和配置，并设置当前用户登录后启动。请保留文件名，无需 sudo。');
    } catch (error) {
      $('update-message').classList.add('error');
      text('update-message', error.message);
    } finally { button.disabled = false; }
  }
  let syncTimer;
  async function syncRelease(start = false) {
    const token = state.token;
    clearTimeout(syncTimer);
    if (!token || !state.admin) return;
    $('sync-release').disabled = true;
    try {
      const result = await api('/api/v1/releases/sync', start ? {} : undefined);
      if (state.token !== token) return;
      if (result.status === 'running') {
        text('sync-message', '正在下载并校验 GitHub 安装包…');
        syncTimer = setTimeout(syncRelease, 2000);
        return;
      }
      text('sync-message', result.status === 'failed' ? '同步失败，请查看网关服务日志。' :
        result.version ? '已同步 GitHub 稳定版 ' + result.version + '；较低版本缓存会自动清理（含手动上传包），正在使用的旧包延后清理。' : '');
      if (result.status === 'complete') await loadUpdates();
    } catch (error) {
      if (start) text('sync-message', error.message);
    }
    $('sync-release').disabled = false;
  }
  async function loadUpdates() {
    const token = state.token;
    if (!token) return;
    try {
      const body = await api('/api/v1/updates');
      if (state.token !== token) return;
      state.updates = Array.isArray(body.updates) ? body.updates : [];
      renderUpdates();
      renderInstall();
      // The per-node upgrade buttons depend on which versions are available.
      if (state.nodes.length) renderNodes();
    } catch (error) {
      if (state.token === token) {
        $('update-message').classList.add('error'); text('update-message', error.message);
      }
    }
  }
  function confirm(title, description, action) {
    text('confirm-title', title); text('confirm-description', description); state.confirm = action;
    $('confirm-dialog').showModal();
  }
  function syncRuleFields() {
    const socks = $('rule-protocol').value === 'socks5';
    $('destination-field').hidden = socks;
    $('socks-field').hidden = !socks;
    // A SOCKS5 exit resolves its target per request, so the fixed destination
    // is not applicable and must not be required by the form.
    for (const id of ['rule-destination', 'rule-target']) {
      $(id).required = !socks;
      if (socks) $(id).value = '';
    }
    if (socks) $('rule-destination').value = '127.0.0.1';
  }
  function openRule(app = null) {
    if (!state.selected) return;
    state.editing = app; $('rule-form').reset(); $('rule-error').hidden = true;
    $('rule-socks-user').value = ''; $('rule-socks-password').value = '';
    text('rule-dialog-title', app ? '编辑转发规则' : '添加转发');
    $('rule-name').value = app?.appName || ''; $('rule-protocol').value = app?.protocol || 'tcp';
    $('rule-source').value = app?.srcPort || ''; $('rule-peer').value = app?.peerNode || '';
    $('rule-destination').value = app?.dstHost || '127.0.0.1'; $('rule-target').value = app?.dstPort || '';
    $('rule-transport').value = app && (Number(app.punchPriority) & 2) ? 'tcp' : 'quic';
    $('rule-whitelist').value = app ? app.whitelist || '' : '127.0.0.1';
    if (app && app.protocol === 'socks5') {
      // The gateway never returns a stored password; show the username and let a
      // blank password mean "keep the existing one".
      $('rule-socks-user').value = app.Username || '';
      $('rule-socks-password').placeholder = app.hasPassword
        ? '留空 = 保留原密码' : '留空 = 不启用认证';
    } else {
      $('rule-socks-password').placeholder = '留空 = 不启用认证';
    }
    $('whitelist-field').hidden = !state.selected.capabilities?.editForward;
    text('rule-help', state.selected.capabilities?.editForward
      ? '规则保存在网关数据库中，节点在线时立即生效，离线时在下次连接后生效。'
      : '规则保存在网关数据库中，节点下次连接后生效。');
    $('peer-names').replaceChildren(...state.nodes.filter(n => n.name !== state.selected.name).map(n => {
      const option = element('option'); option.value = n.name; return option;
    }));
    // Relay candidates: every other registered node, labelled with its NAT type
    // so a node reachable without hairpin NAT is easy to pick.
    const relay = $('rule-relay');
    relay.replaceChildren(element('option', null, '自动选择（按 NAT 质量）'));
    relay.firstChild.value = '';
    // An explicit opt-out lives in the same list: a rule that cannot use a
    // relay (for example both ends behind one NAT) picks this instead.
    const noneOption = element('option', null, '无需中继（只走打洞直连）');
    noneOption.value = '__no_relay__';
    relay.append(noneOption);
    for (const n of state.nodes) {
      if (n.name === state.selected.name) continue;
      const option = element('option', null,
        `${n.name}（UDP：${udpLevel(n)} / TCP：${tcpMapping(n.tcpNatType)}）`);
      option.value = n.name; relay.append(option);
    }
    relay.value = app?.NoRelay ? '__no_relay__' : (app?.relayNode || '');
    syncRuleFields();
    $('rule-dialog').showModal();
  }
  $('rule-protocol').addEventListener('change', syncRuleFields);
  let registering = false;
  function authMode(signup) {
    registering = signup;
    text('login-title', signup ? '注册账号' : '登录控制台');
    text('login-description', signup ? '填写邮箱和密码即可注册。' : '使用邮箱和密码登录。');
    text('login-user-label', signup ? '邮箱' : '邮箱或已有账号');
    $('username').type = signup ? 'email' : 'text';
    $('password').minLength = signup ? 8 : 0;
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('password').value = '';
    $('login-error').hidden = true;
    text('login-submit', signup ? '注册并登录' : '登录控制台');
    text('register-toggle', signup ? '返回登录' : '注册账号');
  }
  $('register-toggle').addEventListener('click', () => authMode(!registering));
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = $('register-toggle').disabled = true; $('login-error').hidden = true;
    try {
      const login = await api('/api/v1/user/' + (registering ? 'register' : 'login'), {
        [registering ? 'email' : 'user']: $('username').value.trim(), password: $('password').value});
      if (typeof login.token !== 'string' || typeof login.installToken !== 'string') throw new Error('无法读取登录凭据。');
      state.token = login.token; state.installToken = login.installToken;
      renderAccount(login); authMode(false);
      persist();
      $('login-screen').hidden = true; $('console').hidden = false;
      route();
      await refresh();
      syncRelease();
    } catch (error) { text('login-error', error.message); $('login-error').hidden = false; }
    finally { $('login-submit').disabled = $('register-toggle').disabled = false; }
  });
  $('mine-account-edit').addEventListener('click', () => {
    $('account-form').reset(); $('account-error').hidden = true;
    $('account-user').value = state.user;
    $('account-user').readOnly = !state.admin;
    $('account-dialog').showModal();
  });
  $('account-form').addEventListener('submit', async event => {
    event.preventDefault(); $('save-account').disabled = true; $('account-error').hidden = true;
    const user = $('account-user').value.trim();
    try {
      await api('/api/v1/user/account', {user, currentPassword: $('current-password').value,
        newPassword: $('new-password').value});
      $('account-dialog').close(); logout(); $('username').value = user;
      text('login-error', '账号已更新，请使用新账号和密码登录。'); $('login-error').hidden = false;
    } catch (error) { text('account-error', error.message); $('account-error').hidden = false; }
    finally { $('save-account').disabled = false; }
  });
  $('account-dialog').addEventListener('close', () => $('account-form').reset());
  $('cancel-account').addEventListener('click', () => $('account-dialog').close());
  $('rule-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!state.selected) return;
    $('save-rule').disabled = true; $('rule-error').hidden = true;
    const node = state.selected, old = state.editing;
    try {
      const socks = $('rule-protocol').value === 'socks5';
      const app = {appName: $('rule-name').value.trim(), protocol: $('rule-protocol').value,
        srcPort: Number($('rule-source').value), peerNode: $('rule-peer').value.trim(),
        punchPriority: $('rule-transport').value === 'tcp' ? 3 : 0};
      if (socks) {
        // The exit selects the destination per SOCKS5 request, so no fixed
        // target is sent. Credentials are optional but must come as a pair.
        app.Username = $('rule-socks-user').value.trim();
        app.Password = $('rule-socks-password').value;
        const keep = old && old.protocol === 'socks5' && old.hasPassword && !app.Password;
        if (keep) {
          // Blank password while editing an authenticated proxy keeps the stored
          // one; the browser never receives it in the first place.
          app.keepPassword = 1;
        } else if (Boolean(app.Username) !== Boolean(app.Password)) {
          throw new Error('SOCKS5 用户名和密码必须同时填写，或同时留空。');
        }
      } else {
        app.dstHost = $('rule-destination').value.trim();
        app.dstPort = Number($('rule-target').value);
      }
      const relay = $('rule-relay').value;
      if (relay) {
        if (relay === app.peerNode) throw new Error('中继节点不能是对端节点本身。');
        if (relay === node.name) throw new Error('中继节点不能是本节点本身。');
        app.relayNode = relay;
      // NoRelay travels inside the rule descriptor: the gateway carries
      // unknown rule fields through to the client untouched.
      if (relay === '__no_relay__') { app.NoRelay = true; app.relayNode = ''; }
      }
      if (!app.appName || app.peerNode === node.name ||
          (!socks && !app.dstHost)) throw new Error('请填写有效名称、对端节点' + (socks ? '' : '和目标地址') + '。');
      if (!node.capabilities?.editForward && (new TextEncoder().encode(app.appName).length > 63 ||
          (!socks && new TextEncoder().encode(app.dstHost).length > 255) ||
          (socks && new TextEncoder().encode(app.Username).length > 255)))
        throw new Error('名称、目标地址或用户名过长，请缩短后重试。');
      if (state.apps.some(a => a !== old && a.protocol === app.protocol && Number(a.srcPort) === app.srcPort))
        throw new Error('此应用协议和入口端口已被使用。');
      if (node.capabilities?.editForward) app.whitelist = $('rule-whitelist').value.trim();
      if (old) { app.protocol0 = old.protocol; app.srcPort0 = old.srcPort; }
      await api('/api/v1/device/' + encodeURIComponent(node.name) + '/app', app);
      $('rule-dialog').close(); message('指令已发送到客户端，正在刷新规则。');
      await new Promise(resolve => setTimeout(resolve, 600)); await loadApps();
    } catch (error) { text('rule-error', error.message); $('rule-error').hidden = false; }
    finally { $('save-rule').disabled = false; }
  });
  $('upload-update').addEventListener('click', () => {
    $('update-form').reset(); $('update-error').hidden = true;
    $('update-dialog').showModal();
  });
  $('close-update-dialog').addEventListener('click', () => $('update-dialog').close());
  $('cancel-update').addEventListener('click', () => $('update-dialog').close());
  $('refresh-updates').addEventListener('click', loadUpdates);
  $('sync-release').addEventListener('click', () => syncRelease(true));
  $('update-form').addEventListener('submit', async event => {
    event.preventDefault();
    const file = $('update-file').files[0];
    const platform = $('update-platform').value, version = $('update-version').value.trim();
    if (!file) { text('update-error', '请选择安装包文件。'); $('update-error').hidden = false; return; }
    if (!/^\d+(\.\d+){0,3}$/.test(version)) {
      text('update-error', '版本号应类似 2.0.2。'); $('update-error').hidden = false; return;
    }
    $('save-update').disabled = true; $('update-error').hidden = true;
    try {
      // Raw binary upload: the gateway hashes the stream as it writes it.
      const response = await fetch('/api/v1/update?platform=' + encodeURIComponent(platform) +
        '&version=' + encodeURIComponent(version), {
        method: 'PUT', body: file, credentials: 'omit',
        headers: {Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/octet-stream'}});
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { logout(true); throw new Error('会话已过期，请重新登录。'); }
      if (!response.ok || body.error) throw new Error(body.detail || '上传失败。');
      $('update-dialog').close();
      message('安装包已上传：' + platform + ' ' + version);
      await loadUpdates(); await refresh();
    } catch (error) { text('update-error', error.message); $('update-error').hidden = false; }
    finally { $('save-update').disabled = false; }
  });
  $('upgrade-all').addEventListener('click', () => confirm('升级所有旧版本',
    '对所有版本低于最新安装包的在线节点下发升级。客户端会从网关下载、校验并重启，连接会短暂中断。',
    async () => {
      const body = await api('/api/v1/upgrades', {});
      const queued = Array.isArray(body.queued) ? body.queued : [];
      const skipped = Array.isArray(body.skipped) ? body.skipped : [];
      trackUpgrades(queued, skipped);
      await new Promise(resolve => setTimeout(resolve, 800)); await refresh();
      return queued.length ? '已向 ' + queued.length + ' 个节点下发升级' + (skipped.length ? '，另有 ' + skipped.length + ' 个节点未下发，原因见客户端升级面板。' : '，正在等待客户端上报新版本。') :
        skipped.length ? skipped.length + ' 个节点无法自动升级，原因见客户端升级面板。' : '没有需要升级的在线节点。';
    }));
  $('confirm-form').addEventListener('submit', async event => {
    event.preventDefault(); $('confirm-action').disabled = true;
    try { const result = await state.confirm?.(); $('confirm-dialog').close(); message(result || '操作已完成。');
      await new Promise(resolve => setTimeout(resolve, 600)); await loadApps();
    } catch (error) { message(error.message, true); $('confirm-dialog').close(); }
    finally { $('confirm-action').disabled = false; state.confirm = null; }
  });

  $('reveal-token').addEventListener('click', () => {
    const hidden = $('install-token').type === 'password'; $('install-token').type = hidden ? 'text' : 'password'; text('reveal-token', hidden ? '隐藏' : '显示');
  });
  $('copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.installToken); text('copy-token', '已复制'); }
    catch {
      $('install-token').type = 'text'; $('install-token').select();
      text('reveal-token', '隐藏'); text('copy-token', '请手动复制');
    }
  });
  function installCommand(platform, url) {
    if (!/^https:\/\/(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:.]+\]):\d+\/api\/v1\/install\/bootstrap\?ticket=[a-f0-9]{48}$/.test(url))
      throw new Error('网关返回的安装链接无效。');
    if (platform === 'linux' || platform === 'macos') {
      const download = platform === 'linux' ? 'wget -qO' : 'curl -fsS -o';
      return `(s=$(mktemp /tmp/fastp2p.XXXXXX) && trap 'rm -f "$s"' 0 && ${download} "$s" '${url}' && sh "$s")`;
    }
    return [
      '& { $d=(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid())) -ErrorAction Stop).FullName; Push-Location -LiteralPath $d -ErrorAction Stop;',
      `try { $f=curl.exe -fsS -OJ -w '%{filename_effective}' '${url}'; if ($LASTEXITCODE) { throw 'Download failed' };`,
      'if ((Start-Process ".\\$f" -Verb RunAs -Wait -PassThru).ExitCode) { throw "Installation failed" }',
      "} finally { Pop-Location; Get-ChildItem -LiteralPath $d -File -Filter 'fastp2p-*.exe' | Remove-Item -Force; Remove-Item -LiteralPath $d } }"
    ].join(' ');
  }
  function renderInstallCommand(platform, wanted) {
    if ($('view-install').hidden) return;
    const section = $('install-commands');
    const latest = wanted.reduce((best, item) => !best || compareVersions(item.version || '0', best.version || '0') > 0 ? item : best, null);
    const version = latest?.automatic ? '' : latest?.version;
    const selection = `${platform}/${version ?? '-'}`;
    if (section.dataset.package === selection) return;
    section.dataset.package = selection;
    if (!latest) {
      section.replaceChildren(element('p', 'muted', '暂无该平台的安装包。'));
      return;
    }
    if (platform === 'android') {
      const download = element('button', 'button primary', '下载 APK');
      download.type = 'button';
      download.addEventListener('click', () => downloadInstaller(latest, download));
      const open = element('a', 'link-button', '打开 FastP2P 并接入');
      open.href = 'fastp2p://install?token=' + encodeURIComponent(state.installToken);
      const actions = element('div', 'install-command-actions');
      actions.append(download, open);
      section.replaceChildren(actions);
      return;
    }
    const label = element('label', '', '安装命令');
    label.htmlFor = 'install-command';
    const command = element('textarea', 'mono');
    command.id = 'install-command'; command.rows = 4; command.readOnly = true;
    command.spellcheck = false;
    const copy = element('button', 'button primary', '复制命令');
    const renew = element('button', 'link-button', '生成新命令');
    copy.type = renew.type = 'button';
    const row = element('div', 'install-command'); row.append(command, copy);
    const status = element('p', 'muted'); status.setAttribute('role', 'status');
    const actions = element('div', 'install-command-actions'); actions.append(renew, status);
    section.replaceChildren(label, row, actions);
    let expiresAt = 0;
    async function generate() {
      command.value = ''; copy.disabled = renew.disabled = true; status.textContent = '正在生成安装命令…';
      try {
        const link = await api('/api/v1/install/link', {platform, version});
        if (!command.isConnected) return;
        command.value = installCommand(platform, link.url);
        expiresAt = Date.now() + link.expiresIn * 1000;
        copy.disabled = false;
        copy.textContent = '复制命令';
        status.textContent = '命令 10 分钟内有效，下载一次后失效。';
      } catch (error) { status.textContent = error.message; }
      finally { renew.disabled = false; }
    }
    copy.addEventListener('click', async () => {
      if (Date.now() >= expiresAt) await generate();
      if (!command.value) return;
      try { await navigator.clipboard.writeText(command.value); copy.textContent = '已复制'; }
      catch { command.focus(); command.select(); copy.textContent = '请手动复制'; }
    });
    renew.addEventListener('click', generate);
    generate();
  }
  function renderInstall() {
    const list = $('install-list');
    const platform = state.installPlatform;
    const notes = {
      windows: '在 PowerShell 中运行，按提示确认管理员权限。',
      macos: '在 macOS 13 或更新版本的终端中，用当前登录用户运行。',
      linux: '在有 wget 的 Linux 终端中运行，按提示使用 sudo。脚本会识别 CPU 架构并安装服务。',
      android: '在手机上下载并安装 APK，然后回到此页点「打开 FastP2P 并接入」。'
    };
    text('install-note', notes[platform]);
    list.closest('details').hidden = platform === 'android';
    const wanted = availableDownloads().filter(update =>
      update.platform === platform || update.platform.startsWith(platform + '-'));
    renderInstallCommand(platform, wanted);
    if (platform === 'android') return;
    if (!wanted.length) {
      list.replaceChildren(element('p', 'muted install-empty',
        '暂无该平台的安装包。'));
      return;
    }
    list.replaceChildren(...wanted.map(update => {
      const row = element('div', 'install-row');
      const label = update.automatic ? update.label + ' 通用安装脚本' : (update.label || update.platform) + ' · ' + update.version;
      row.append(element('span', 'install-label', label));
      const button = element('button', 'button primary', '下载');
      button.type = 'button';
      button.setAttribute('aria-label', '下载 ' + label);
      button.addEventListener('click', () => downloadInstaller(update, button));
      row.append(button);
      return row;
    }));
  }
  function selectInstallTab(platform) {
    state.installPlatform = platform;
    for (const tab of document.querySelectorAll('.install-tab')) {
      const selected = tab.dataset.platform === platform;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    renderInstall();
  }
  for (const tab of document.querySelectorAll('.install-tab'))
    tab.addEventListener('click', () => selectInstallTab(tab.dataset.platform));
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  for (const item of navItems)
    item.addEventListener('click', () => { location.hash = '#/' + item.dataset.view; });

  const PAGES = ['overview', 'devices', 'device', 'install', 'mine'];
  function showView(name) {
    for (const page of PAGES) $('view-' + page).hidden = page !== name;
    for (const item of navItems) {
      const current = item.dataset.view === (name === 'device' ? 'devices' : name);
      item.classList.toggle('active', current);
      if (current) {
        item.setAttribute('aria-current', 'page');
        text('page-title', name === 'device' ? '设备详情' : item.dataset.label);
      } else item.removeAttribute('aria-current');
    }
  }
  function renderInstallPage() {
    $('install-token').value = state.installToken;
    $('install-token').type = 'password';
    text('reveal-token', '显示');
    text('copy-token', '复制 Token');
    renderInstall();
  }
  function renderMinePage() {
    text('mine-account', state.email || state.user || '—');
    text('mine-token', state.installToken || '—');
    text('mine-account-edit', state.admin ? '修改账号与密码' : '修改密码');
  }
  function goToDevice(name) {
    const target = '#/device/' + encodeURIComponent(name);
    if (location.hash === target) route();
    else location.hash = target;
  }
  function deviceRoute() {
    return /^#\/device\/([A-Za-z0-9_-]{8,31})(\/rules)?$/.exec(location.hash);
  }
  async function route() {
    const hash = location.hash || '#/overview';
    const device = deviceRoute();
    message('');
    window.scrollTo(0, 0);
    if (device) {
      const [, name, rules] = device;
      showView('device');
      if (state.selected?.name !== name) clearDevice(name, '正在获取设备记录…');
      if (await refreshDevice(name) && rules && location.hash === hash)
        $('device-rules').scrollIntoView({block: 'start'});
      return;
    }
    if (state.selected) selectNode(null);
    if (hash === '#/install') { showView('install'); renderInstallPage(); return; }
    if (hash === '#/mine') { showView('mine'); renderMinePage(); return; }
    if (hash === '#/overview' || hash === '#/') { showView('overview'); return; }
    showView('devices');
  }
  function clearDevice(name, message) {
    if (state.selected) selectNode(null);
    text('device-heading', name);
    text('device-summary', message);
    $('device-fields').replaceChildren();
    $('device-rules').hidden = true;
  }
  let deviceRequest = 0;
  async function refreshDevice(name) {
    const token = state.token;
    if (!token) return false;
    const request = ++deviceRequest;
    const current = () => state.token === token && request === deviceRequest && deviceRoute()?.[1] === name;
    try {
      let node = state.nodes.find(n => n.name === name);
      if (!node) {
        const result = await api('/api/v1/nodes?name=' + encodeURIComponent(name));
        node = result.nodes?.[0];
      }
      if (!current()) return false;
      if (!node) {
        clearDevice(name, '找不到此设备的登记记录。');
        return false;
      }
      renderDevicePage(node);
      $('device-rules').hidden = false;
      if (state.selected?.name !== name || state.selected.isActive !== node.isActive) selectNode(node);
      else {
        state.selected = node;
        if (!$('rule-dialog').open && !$('confirm-dialog').open) loadApps({quiet: true});
      }
      return true;
    } catch (error) {
      if (current()) clearDevice(name, error.message);
      return false;
    }
  }
  function renderDevicePage(node) {
    text('device-heading', (node.alias || node.name));
    text('device-summary', (node.os || '未知系统') + ' · ' + (node.ip || '—'));
    const fields = $('device-fields');
    const rows = [
      ['设备名字', node.name],
      ['操作系统', node.os || '—'],
      ['软件版本', node.version || '—'],
      ['公网 IPv4', node.ip || '—'],
      ['公网 IPv6', node.ipv6 || '—'],
      ['内网 IP', node.lanip || '—'],
      ['业务端口', node.publicIPPort ? `${node.publicIPPort} / TCP` : '—'],
      ['NAT 类型', 'UDP：' + udpLevel(node) + ' / TCP：' + tcpLabel(node)],
      ['最近活跃', node.activetime ? String(node.activetime) : '—'],
      ['状态', Number(node.isActive) === 1 ? '在线' : '离线'],
    ];
    fields.replaceChildren(...rows.map(([label, value]) => {
      const row = element('div', 'device-field');
      const field = element('span', 'device-field-value mono', String(value));
      if (label === '设备名字') {
        const rename = element('button', 'link-button device-rename', '改名');
        rename.type = 'button'; rename.disabled = !node.capabilities?.rename;
        if (rename.disabled) rename.title = '请先升级客户端并让设备重新连接';
        rename.addEventListener('click', () => openRename(node.name));
        field.append(rename);
      }
      row.append(element('span', 'device-field-label', label), field);
      return row;
    }));
  }
  let renameFrom = '';
  function openRename(name) {
    renameFrom = name;
    $('new-device-name').value = name;
    $('rename-error').hidden = true;
    $('rename-dialog').showModal();
    $('new-device-name').select();
  }
  $('cancel-rename').addEventListener('click', () => $('rename-dialog').close());
  $('rename-form').addEventListener('submit', async event => {
    event.preventDefault(); $('save-rename').disabled = true; $('rename-error').hidden = true;
    const token = state.token, previous = renameFrom;
    try {
      const result = await api('/api/v1/device/' + encodeURIComponent(previous) + '/rename', {name: $('new-device-name').value});
      if (state.token !== token) return;
      $('rename-dialog').close();
      state.nodes = state.nodes.filter(node => node.name !== previous);
      goToDevice(result.name);
      await refresh();
    } catch (error) { text('rename-error', error.message); $('rename-error').hidden = false; }
    finally { $('save-rename').disabled = false; }
  });
  window.addEventListener('hashchange', route);
  $('device-back-inline').addEventListener('click', () => { location.hash = '#/devices'; });
  $('side-logout').addEventListener('click', () => logout()); $('refresh').addEventListener('click', refresh);
  let searchTimer;
  $('node-search').addEventListener('input', () => {
    state.offset = 0; renderNodes(); clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 200);
  });
  $('previous-nodes').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 100); refresh(); });
  $('next-nodes').addEventListener('click', () => { state.offset += 100; refresh(); });
  $('refresh-apps').addEventListener('click', loadApps);
  $('add-rule').addEventListener('click', () => openRule());
  for (const id of ['close-rule-dialog', 'cancel-rule']) $(id).addEventListener('click', () => $('rule-dialog').close());
  $('cancel-confirm').addEventListener('click', () => $('confirm-dialog').close());
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && typeof saved.token === 'string' && saved.token) {
      state.token = saved.token;
      state.installToken = typeof saved.installToken === 'string' ? saved.installToken : '';
      $('login-screen').hidden = true; $('console').hidden = false;
    }
  } catch { try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } }
  route();
  if (state.token) {
    refresh();
    syncRelease();
  }
})();
