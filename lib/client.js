/**
 * dsh-codebuddy-auth —— 浏览器端客户端插件（零构建 bundle）。
 *
 * 参照 dsh-cline-pass 的 WebUI 做法：由 package.json 的 `dsh.client` 声明被 web
 * shell 自动加载（`window.__ModuleLoader__.load({ id, factory })`，factory 内用
 * 宿主注入的 `require` 拿 react）。它把 CodeBuddy 设置注册进内置「设置 → 内置
 * 插件」的一个 tab（`settings.plugins.tab` 槽），面板通过单条 dispatch 路由
 * `POST /api/codebuddy`（body `{ endpoint, payload }`）调用 lib/web.mjs 注册的
 * Connection 鉴权端点。
 *
 * 刻意用 React.createElement 手写、不引入 JSX/构建步骤，保持插件零依赖零构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codebuddy-auth',
  factory: function (require) {
    var module = { exports: {} };
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var PANEL_PATH = '/api/codebuddy';
    var NS = 'dsh-codebuddy-auth';

    /** One dispatch call: unwrap { ok, value } / throw { error }. */
    function call(endpoint, payload) {
      return fetch(PANEL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: endpoint, payload: payload || {} }),
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (result) {
          if (!r.ok || !result || result.ok !== true) {
            throw new Error((result && result.error && result.error.message) || ('面板路由返回 HTTP ' + r.status));
          }
          return result.value;
        });
      });
    }

    // ---- 小组件 -------------------------------------------------------- //
    function chip(text, tone) {
      return h('span', { style: { background: 'rgba(127,127,127,.16)', color: tone || 'inherit', borderRadius: 999, padding: '1px 8px', fontSize: 12, marginRight: 4 } }, text);
    }
    function button(label, onClick, opts) {
      opts = opts || {};
      return h('button', {
        onClick: onClick,
        disabled: opts.disabled,
        style: {
          font: 'inherit', cursor: 'pointer', borderRadius: 7, padding: '4px 10px', fontSize: 13,
          border: '1px solid rgba(127,127,127,.35)',
          background: opts.primary ? '#006eff' : 'transparent',
          color: opts.primary ? '#fff' : (opts.danger ? '#d14' : 'inherit'),
        },
      }, label);
    }
    function fmtCredits(q) {
      if (!q) return '积分未查询';
      return '剩余 ' + Math.round(q.remaining) + ' / 总额 ' + Math.round(q.total);
    }
    function fmtExpiry(ms) {
      if (!ms) return '令牌未知';
      try { return '到期 ' + new Date(ms).toLocaleString(); } catch (e) { return '到期未知'; }
    }

    function AccountRow(props) {
      var a = props.account; var busy = props.busy; var on = props.on;
      return h('div', {
        key: a.id,
        style: {
          display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
          border: '1px solid ' + (a.active ? '#006eff' : 'rgba(127,127,127,.25)'),
          borderRadius: 10, padding: '10px 12px', marginBottom: 8, opacity: a.enabled ? 1 : 0.6,
        },
      },
        h('div', { style: { minWidth: 160 } },
          h('div', { style: { fontWeight: 600 } }, a.nickname || a.uid || a.id),
          h('div', { style: { fontSize: 12, opacity: 0.7 } }, (a.edition === 'intl' ? '国际版' : '国内版') + ' · ' + fmtExpiry(a.expiresAt)),
        ),
        h('div', { style: { minWidth: 140, fontVariantNumeric: 'tabular-nums' } }, fmtCredits(a.quota)),
        h('div', { style: { flex: '1 1 auto', display: 'flex', flexWrap: 'wrap', gap: 4 } },
          a.active ? chip('活跃', '#006eff') : null,
          a.locked ? chip('已锁定', '#b45309') : null,
          !a.enabled ? chip('已禁用', '#b42318') : null,
          a.coolingUntil ? chip('冷却·' + (a.cooldownReason || ''), '#b45309') : null,
          a.quota && a.quota.exhausted ? chip('额度耗尽', '#b42318') : null,
        ),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          !a.active ? button('激活', function () { on('activate', { id: a.id }); }, { primary: true, disabled: busy }) : null,
          button(a.locked ? '解锁' : '锁定', function () { on('lock', { id: a.id, lock: !a.locked }); }, { disabled: busy }),
          button(a.enabled ? '禁用' : '启用', function () { on('enable', { id: a.id, enabled: !a.enabled }); }, { disabled: busy }),
          button('刷新配额', function () { props.onQuota(a.id); }, { disabled: busy }),
          button('删除', function () { if (window.confirm('删除该账户？其令牌将被移除。')) on('remove', { id: a.id }); }, { danger: true, disabled: busy }),
        ),
      );
    }

    function CodeBuddyPanel() {
      var s1 = useState(null); var data = s1[0]; var setData = s1[1];
      var s2 = useState(''); var msg = s2[0]; var setMsg = s2[1];
      var s3 = useState(false); var busy = s3[0]; var setBusy = s3[1];
      var s4 = useState(null); var login = s4[0]; var setLogin = s4[1];
      var s5 = useState('cn'); var edition = s5[0]; var setEdition = s5[1];
      var s6 = useState(false); var showImport = s6[0]; var setShowImport = s6[1];
      var s7 = useState(''); var importText = s7[0]; var setImportText = s7[1];

      var flash = useCallback(function (m) { setMsg(m); window.setTimeout(function () { setMsg(''); }, 3000); }, []);
      var refresh = useCallback(function () {
        return call('state').then(function (v) { if (v) setData(v); }).catch(function (e) { flash('读取失败：' + e.message); });
      }, [flash]);

      useEffect(function () { refresh(); }, [refresh]);

      // 登录轮询：login 存在时每 3s 拉一次，成功即刷新并清空。
      useEffect(function () {
        if (!login || !login.state) return;
        var timer = window.setInterval(function () {
          call('login.poll', { state: login.state }).then(function (p) {
            if (p && p.done) { setLogin(null); flash('登录成功：' + ((p.account && p.account.nickname) || '新账户')); if (p.accounts) setData(p); else refresh(); }
          }).catch(function () { /* transient; keep polling until timeout */ });
        }, 3000);
        return function () { window.clearInterval(timer); };
      }, [login, refresh, flash]);

      function control(endpoint, body) {
        setBusy(true);
        call(endpoint, body).then(function (v) { setBusy(false); if (v && v.accounts) setData(v); else refresh(); }).catch(function (e) { setBusy(false); flash('操作失败：' + e.message); });
      }
      function refreshQuota(id) {
        setBusy(true);
        call('quota', { id: id }).then(function () { setBusy(false); flash('配额已更新'); refresh(); }).catch(function (e) { setBusy(false); flash('配额查询失败：' + e.message); });
      }
      function startLogin() {
        setBusy(true);
        call('login.start', { edition: edition }).then(function (r) {
          setBusy(false);
          setLogin({ state: r.state, url: r.url });
          try { window.open(r.url, '_blank', 'noopener'); } catch (e) { /* 让用户点链接 */ }
        }).catch(function (e) { setBusy(false); flash('启动登录失败：' + e.message); });
      }
      function syncModels() {
        setBusy(true);
        call('models', {}).then(function (r) { setBusy(false); flash('模型已同步：' + ((r && r.models || []).length) + ' 个'); }).catch(function (e) { setBusy(false); flash('同步失败：' + e.message); });
      }
      function doExport() {
        call('export', {}).then(function (doc) {
          var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a'); a.href = url; a.download = 'codebuddy-accounts.json'; a.click();
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }).catch(function (e) { flash('导出失败：' + e.message); });
      }
      function doImport() {
        var txt = (importText || '').trim();
        if (!txt) { flash('请粘贴 JSON'); return; }
        var doc; try { doc = JSON.parse(txt); } catch (e) { flash('JSON 解析失败'); return; }
        setBusy(true);
        call('import', { doc: doc }).then(function (r) { setBusy(false); flash('导入：新增 ' + r.added + '，更新 ' + r.updated); setShowImport(false); setImportText(''); if (r.accounts) setData(r); else refresh(); }).catch(function (e) { setBusy(false); flash('导入失败：' + e.message); });
      }

      var accounts = (data && data.accounts) || [];
      return h('div', { style: { padding: '4px 2px', lineHeight: 1.5 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
          h('h3', { style: { margin: 0, fontSize: 16, flex: '1 1 auto' } }, 'CodeBuddy 账户'),
          data && data.cliVersion ? h('span', { style: { fontSize: 12, opacity: 0.7 } }, 'CLI ' + data.cliVersion + (data.models ? (' · ' + data.models + ' 模型') : '')) : null,
        ),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' } },
          button('＋ 添加账户（登录）', startLogin, { primary: true, disabled: busy }),
          h('select', { value: edition, onChange: function (e) { setEdition(e.target.value); }, style: { font: 'inherit', borderRadius: 7, padding: '4px 8px' } },
            h('option', { value: 'cn' }, '国内版'), h('option', { value: 'intl' }, '国际版')),
          button('同步模型', syncModels, { disabled: busy }),
          button('导出', doExport),
          button('导入', function () { setShowImport(!showImport); }),
          button('刷新', function () { refresh(); }),
        ),
        login ? h('div', { style: { border: '1px dashed #006eff', borderRadius: 10, padding: '10px 12px', marginBottom: 12 } },
          h('div', { style: { marginBottom: 6 } }, '请在浏览器完成登录，登录后此页会自动写入账户：'),
          h('a', { href: login.url, target: '_blank', rel: 'noreferrer', style: { wordBreak: 'break-all', color: '#006eff' } }, login.url),
          h('div', { style: { marginTop: 8 } }, button('取消登录', function () { setLogin(null); }, { danger: true })),
        ) : null,
        showImport ? h('div', { style: { marginBottom: 12 } },
          h('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, '粘贴导出的账户 JSON（含令牌，仅本机处理）：'),
          h('textarea', { value: importText, onChange: function (e) { setImportText(e.target.value); }, style: { width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: 12, borderRadius: 8, padding: 8 } }),
          h('div', { style: { marginTop: 6, display: 'flex', gap: 8 } }, button('确认导入', doImport, { primary: true, disabled: busy }), button('取消', function () { setShowImport(false); })),
        ) : null,
        accounts.length === 0
          ? h('div', { style: { padding: 20, textAlign: 'center', opacity: 0.7 } }, '还没有账户，点上方「添加账户（登录）」开始。')
          : h('div', null, accounts.map(function (a) { return h(AccountRow, { key: a.id, account: a, busy: busy, on: control, onQuota: refreshQuota }); })),
        msg ? h('div', { style: { marginTop: 8, fontSize: 13, color: '#006eff' } }, msg) : null,
      );
    }

    // ---- 挂载进内置「设置 → 内置插件」的一个 tab --------------------- //
    function apply(ctx) {
      // slots + connection 都就绪后再注册：connection 通道要等 web server 激活，
      // 面板的每次调用都走它（与 dsh-cline-pass 一致）。
      ctx.inject(['slots', 'connection'], function (scope) {
        try {
          scope.slots.inject('settings.plugins.tab', function () {
            return scope.slots.register({
              name: 'settings.plugins.tab',
              id: 'codebuddy',
              order: 20,
              label: function () { return 'CodeBuddy'; },
              locale: NS,
              inject: function () { return {}; },
            }, CodeBuddyPanel);
          });
        } catch (error) {
          console.error('dsh-codebuddy-auth: settings tab registration failed', error);
        }
      });
    }

    var inject = [];
    module.exports = { apply: apply, inject: inject, default: { apply: apply, inject: inject } };
    module.exports.__esModule = true;
    return module.exports;
  },
});
