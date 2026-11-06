/**
 * dsh-onebot-channel —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册「QQ 桥接」设置页（slot: settings.section）：
 *   - 每个 QQ 好友 / 群 → 绑定一个 DSH 会话 + 可选的正文前缀；
 *   - 没绑定的号发来的消息一律忽略（不发散、不兜底）；
 *   - 对话节奏（沉默权）、关系记忆、推送链路、高级参数都在这一页里调。
 *
 * 与宿主只走同源 HTTP（/api/qq-bridge/*），不碰 RPC。
 * 改完用 node --check lib/client.js 验语法（它是表达式，check 只验语法不执行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-onebot-channel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/api/qq-bridge'

    // ---- 同源 API ---------------------------------------------------------

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function readJson(response) {
      return response.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          throw new Error('接口返回的不是 JSON：' + text.slice(0, 120))
        }
        if (response.ok !== true) {
          throw new Error((data && data.error) || 'HTTP ' + response.status)
        }
        return data
      })
    }

    function errText(error) {
      return error && error.message ? error.message : String(error)
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.qqb-wrap{display:flex;flex-direction:column;gap:16px;padding:4px 2px;font-size:13px;}',
      '.qqb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.qqb-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-desc{color:var(--dsw-alias-label-secondary,#5b6270);line-height:1.65;}',
      '.qqb-card{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden;}',
      '.qqb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#f6f7f9);border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6eb);}',
      '.qqb-card-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-row{display:grid;grid-template-columns:118px 1fr 200px 118px auto;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-row:last-child{border-bottom:0;}',
      '.qqb-empty{padding:14px 12px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.qqb-uin{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-name{color:var(--dsw-alias-label-secondary,#5b6270);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-input,.qqb-select{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d0d4da);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;}',
      '.qqb-btn{padding:5px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d0d4da);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;font-size:12px;white-space:nowrap;}',
      '.qqb-btn:hover{background:var(--dsw-alias-bg-layer-2,#f2f4f7);}',
      '.qqb-btn.primary{background:var(--dsw-alias-brand-primary,#2f6feb);border-color:var(--dsw-alias-brand-primary,#2f6feb);color:#fff;}',
      '.qqb-btn.primary:disabled{opacity:.55;cursor:default;}',
      '.qqb-btn.danger{color:var(--dsw-alias-state-error-primary,#c9302c);}',
      '.qqb-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-msg{font-size:12px;}',
      '.qqb-msg.ok{color:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.qqb-msg.err{color:var(--dsw-alias-state-error-primary,#c9302c);}',
      '.qqb-note{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;line-height:1.6;}',
      '.qqb-err{color:var(--dsw-alias-state-error-primary,#c9302c);white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;}',
      '.qqb-adv{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px 20px;padding:12px;}',
      '.qqb-field{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.qqb-field-label{flex:0 0 112px;color:var(--dsw-alias-label-secondary,#5b6270);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-num{width:82px;flex:0 0 auto;}',
      '.qqb-unit{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;}',
      '.qqb-check{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-hint-inline{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;}',
      '.qqb-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.qqb-self{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-self-uin{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-self-name{color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#c9302c);display:inline-block;flex:0 0 auto;}',
      '.qqb-self.on .qqb-dot{background:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.qqb-warn{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warning-primary,#b8860b);background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#1f2328);line-height:1.6;}',
      '.qqb-mem{display:flex;flex-direction:column;gap:4px;padding:10px 12px;}',
      '.qqb-mem-row{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.6;}',
      '.qqb-mem-key{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);flex:0 0 auto;}',
      '.qqb-sec-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);padding:10px 12px 0;}',
      // 0.9.1：功能分区导航 —— 卡片一多就变成一堵墙，改成「上面列功能、点进去只看到那一块」
      '.qqb-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6eb);padding:0 2px;background:transparent;}',
      '.qqb-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);font-size:12.5px;font-family:inherit;padding:8px 12px 9px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;border-radius:6px 6px 0 0;}',
      '.qqb-tab:hover{background:var(--dsw-alias-bg-layer-2,#f2f4f7);color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-tab.on{color:var(--dsw-alias-label-primary,#1f2328);border-bottom-color:var(--dsw-alias-brand-primary,#2f6feb);font-weight:600;}',
      '.qqb-tab-badge{margin-left:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.qqb-pane{display:flex;flex-direction:column;gap:12px;}',
      '.qqb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;}',
      '.qqb-stat{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:3px;}',
      '.qqb-stat-n{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums;}',
      '.qqb-stat-l{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-stat.on{border-color:var(--dsw-alias-brand-primary,#2f6feb);}',
      '.qqb-tgt-row{display:grid;grid-template-columns:auto 110px 1fr auto;gap:8px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-tgt-row:last-child{border-bottom:0;}',
      '.qqb-tgt-main{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.qqb-mode{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px 12px 0;}',
    ].join('\n')

    function ensureStyles() {
      var id = 'dsh-onebot-channel-style'
      if (document.getElementById(id) !== null) return
      var el = document.createElement('style')
      el.id = id
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---- 错误边界：设置页崩了要看得见原因，不能整块白屏 ---------------------
    //
    // 必须用 class + getDerivedStateFromError。函数组件里 throw 是接不住的，
    // 异常会一路冒到最外层，整个设置面板直接消失（之前就是这么白屏的）。

    class SectionErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      render() {
        var error = this.state.error
        if (error !== null && error !== undefined) {
          var detail = String(error && error.message ? error.message : error)
          return h('div', { className: 'qqb-wrap' }, [
            h('div', { className: 'qqb-title', key: 't' }, 'QQ 桥接：页面渲染出错'),
            h('div', { className: 'qqb-err', key: 'e' }, detail),
            h('div', { className: 'qqb-note', key: 'n' }, '完整堆栈看 DSH 的开发者工具控制台；也可以直接把这句话发给小薇。'),
          ])
        }
        return this.props.children
      }
    }

    // ---- 设置页主体 -------------------------------------------------------

    /** 路径比较用：大小写、斜杠方向、结尾斜杠都可能不一致，先归一化再比。 */
    function normCwd(value) {
      return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /**
     * 浏览器端的会话列表：比宿主端全（含没打开的会话），而且带 displayTitle。
     * 拿不到就返回空数组，退回宿主端那份，别让设置页崩。
     */
    function clientSessions(ctx, wantCwd) {
      try {
        var store = ctx && ctx.sessions ? ctx.sessions.list : null
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return []
        var snap = store.getSnapshot()
        var byId = (snap && snap.byId) || {}
        var want = normCwd(wantCwd)
        var out = []
        for (var key in byId) {
          if (Object.prototype.hasOwnProperty.call(byId, key) !== true) continue
          var item = byId[key]
          if (item === null || item === undefined) continue
          var cwd = String(item.cwd || '')
          if (want !== '' && cwd !== '' && normCwd(cwd) !== want) continue
          out.push({
            id: String(item.id || key),
            title: String(item.displayTitle || item.title || '').trim(),
            cwd: cwd,
            updatedAt: String(item.updatedAt || ''),
          })
        }
        return out
      } catch (error) {
        return []
      }
    }

    /** 合并宿主端和浏览器端两份会话列表：id 去重，标题留有的，时间留新的。 */
    function mergeSessions(serverList, clientList) {
      var byId = {}
      var order = []

      function put(item) {
        if (item === null || item === undefined) return
        var id = String(item.id || '').trim()
        if (id === '') return
        var title = String(item.title || '').trim()
        var updatedAt = String(item.updatedAt || '')
        var old = byId[id]
        if (old === undefined) {
          byId[id] = { id: id, title: title, cwd: String(item.cwd || ''), updatedAt: updatedAt }
          order.push(id)
          return
        }
        if (title !== '') old.title = title
        if (updatedAt > old.updatedAt) old.updatedAt = updatedAt
        if (old.cwd === '') old.cwd = String(item.cwd || '')
      }

      ;(serverList || []).forEach(put)
      ;(clientList || []).forEach(put)
      var out = order.map(function (id) { return byId[id] })
      // 空壳会话排到最后（前缀跟 index.js 里保持一致）
      function rank(item) { return item.title.indexOf('（空会话') === 0 ? 1 : 0 }
      out.sort(function (a, b) {
        if (rank(a) !== rank(b)) return rank(a) - rank(b)
        return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
      })
      return out
    }

    function sessionLabel(session) {
      var title = String(session.title || '').trim()
      if (title !== '') return title
      // 没标题（新会话还没消息）时，别拿带 session- 前缀的 id 截前 8 位——那只会显示 "session-"
      var bare = String(session.id || '').replace(/^session-/, '')
      var stamp = String(session.updatedAt || '')
      var time = stamp.length >= 16 ? ' · ' + stamp.slice(5, 16).replace('T', ' ') : ''
      return '#' + bare.slice(0, 8) + time
    }

    /** 头部那枚「当前接入的 QQ」徽章：绿点=链路通，红点=连不上。 */
    function selfBadge(self) {
      if (self === null || self === undefined || String(self.uin || '') === '') {
        return h('span', { className: 'qqb-self', key: 'self' }, [
          h('span', { className: 'qqb-dot', key: 'd' }),
          h('span', { key: 'x' }, '未连接 / 未登录'),
        ])
      }
      var name = String(self.name || '')
      return h('span', { className: 'qqb-self on', key: 'self' }, [
        h('span', { className: 'qqb-dot', key: 'd' }),
        h('span', { className: 'qqb-self-uin', key: 'u' }, String(self.uin)),
        name === '' ? null : h('span', { className: 'qqb-self-name', key: 'n' }, '「' + name + '」'),
      ])
    }

    /** WS 推送状态徽章：绿点=已连上（实时），灰点=没连（走轮询兜底）。 */
    function wsBadge(ws) {
      if (ws === null || ws === undefined) return null
      var on = ws.connected === true
      var text = on
        ? '推送已连（实时）'
        : (ws.lastError ? '推送断开（轮询兜底）' : '推送未连（轮询兜底）')
      return h('span', { className: 'qqb-self' + (on ? ' on' : ''), key: 'ws' }, [
        h('span', { className: 'qqb-dot', key: 'd' }),
        h('span', { className: 'qqb-self-name', key: 'n' }, text),
      ])
    }

    /**
     * 设置页的功能分区（0.9.1）。
     * 卡片一多，竖着排下来就是一堵墙 —— 用户找不到东西，只能问「XX 在哪」。
     * 改成「上面列功能、点进去只看那一块」，以后加功能就是往这里加一行。
     */
    var TABS = [
      ['overview', '概览'],
      ['binding', '绑定'],
      ['stance', '对话节奏'],
      ['proactive', '主动搭话'],
      ['memory', '关系记忆'],
      ['ws', '配置'],
      ['advanced', '高级'],
    ]

    function QqBridgeSection(props) {
      var s1 = useState(null)
      var data = s1[0]
      var setData = s1[1]

      // 浏览器端会话列表变化时重渲染（新开会话 / 改标题都能立刻反映到下拉里）
      var sTick = useState(0)
      var setTick = sTick[1]

      var s2 = useState({ private: {}, group: {} })
      var draft = s2[0]
      var setDraft = s2[1]

      var s3 = useState({ private: '', group: '' })
      var input = s3[0]
      var setInput = s3[1]

      var s4 = useState('')
      var msg = s4[0]
      var setMsg = s4[1]

      var s5 = useState(false)
      var busy = s5[0]
      var setBusy = s5[1]

      var s6 = useState(false)
      var loading = s6[0]
      var setLoading = s6[1]

      var s7 = useState(null)
      var tunables = s7[0]
      var setTunables = s7[1]

      // 功能分区（0.9.1）：一屏只显示一块，别再把所有卡片堆成一堵墙
      var s8 = useState('overview')
      var tab = s8[0]
      var setTab = s8[1]

      // 主动搭话的选人模式：'all' 全员 / 'some' 只对勾选的人。
      // 「some 但一个都没勾」需要一个本地中间态，不能直接靠空数组表达（空数组 = 全员）。
      var s9 = useState('all')
      var targetMode = s9[0]
      var setTargetMode = s9[1]

      /**
       * 工作区注册表（0.18.4）：`null` = 还没问过，`{ ok, list }` = 问过了。
       *
       * ⚠️ 这个 useState 必须**加在最后**（s10）：tests/client-render.mjs 是按
       *    useState 的调用顺序喂种子的（s1…s9），中间插一个会让后面全部错位。
       *    加在末尾时它会拿到自己的初始值，测试不用改。
       *
       * ok=false 表示「接口或注册表读不到」—— 这时界面降级成手填路径，
       * 但仍要能看出是降级了，不能装成「一个工作区都没有」。
       */
      var s10 = useState(null)
      var workspaces = s10[0]
      var setWorkspaces = s10[1]

      function reload() {
        setLoading(true)
        setMsg('')
        apiGet('/state')
          .then(function (result) {
            setData(result)
            setDraft({
              private: result.routes && result.routes.private ? result.routes.private : {},
              group: result.routes && result.routes.group ? result.routes.group : {},
            })
            var c = result.config || {}
            setTunables({
              // 0.18.4：工作区进了表单状态。
              // 它不属于 NUMERIC/BOOLEAN/STRING_FIELDS（走 /save 的独立分支，
              // 要先按注册表校验），但**仍然要在这里有个初始值** ——
              // 否则「绑定」页那个下拉框读到的是上一次的值，换了工作区不刷新页面就看不到。
              workspaceCwd: String(c.workspaceCwd || ''),
              groupContextCount: Number(c.groupContextCount || 0),
              groupOnlyWhenAt: c.groupOnlyWhenAt === true,
              splitReply: c.splitReply === true,
              // 0.10.0：分条依据（paragraph = 换行分条，sentence = 按句末标点）
              splitMode: c.splitMode === 'sentence' ? 'sentence' : 'paragraph',
              splitMaxChars: Number(c.splitMaxChars || 120),
              splitMaxParts: Number(c.splitMaxParts || 8),
              splitMinChars: Number(c.splitMinChars || 0),
              splitDelayMinMs: Number(c.splitDelayMinMs || 200),
              splitDelayMaxMs: Number(c.splitDelayMaxMs || 700),
              pollMs: Number(c.pollMs || 2000),
              groupPollMs: Number(c.groupPollMs || 3000),
              resumeColdSession: c.resumeColdSession !== false,
              // 0.7.1：对话节奏与沉默权
              replyQuietMs: Number(c.replyQuietMs || 0),
              waitMaxMs: Number(c.waitMaxMs || 60000),
              waitTurnMaxMs: Number.isFinite(Number(c.waitTurnMaxMs)) ? Number(c.waitTurnMaxMs) : 60000,
              closureEnabled: c.closureEnabled !== false,
              // 0.17.5：跨工作区会话进度（2026-11-05）
              // ⚠️ qqCommandPrefix 用 String(...) 而不是 `|| '/'`：
              //    空串是**有意义的**（= 关闭命令层），被 `||` 兜成 '/' 就永远关不掉了。
              qqCommandPrefix: typeof c.qqCommandPrefix === 'string' ? c.qqCommandPrefix : '/',
              focusTagEnabled: c.focusTagEnabled !== false,
              focusIdleResetMs: Number.isFinite(Number(c.focusIdleResetMs)) ? Number(c.focusIdleResetMs) : 3600000,
              progressMaxRows: Number.isFinite(Number(c.progressMaxRows)) ? Number(c.progressMaxRows) : 12,
              progressIdleWindowMs: Number.isFinite(Number(c.progressIdleWindowMs)) ? Number(c.progressIdleWindowMs) : 86400000,
              // 0.8.0：关系记忆与上线补历史
              memoryEnabled: c.memoryEnabled !== false,
              // 0.9.0：私聊合并窗口（标记已读的中间态）
              mergeWindowMs: Number(c.mergeWindowMs || 0),
              mergeMaxWaitMs: Number(c.mergeMaxWaitMs || 15000),
              mergeMaxMessages: Number(c.mergeMaxMessages || 10),
              windowEnabled: c.windowEnabled !== false,
              windowIdleMs: Number.isFinite(Number(c.windowIdleMs)) ? Number(c.windowIdleMs) : 120000,
              windowMaxMs: Number.isFinite(Number(c.windowMaxMs)) ? Number(c.windowMaxMs) : 600000,
              windowMaxReplies: Number.isFinite(Number(c.windowMaxReplies)) ? Number(c.windowMaxReplies) : 5,
              windowPerPeerDaily: Number.isFinite(Number(c.windowPerPeerDaily)) ? Number(c.windowPerPeerDaily) : 10,
              windowPerGroupDaily: Number.isFinite(Number(c.windowPerGroupDaily)) ? Number(c.windowPerGroupDaily) : 20,
              waterWindows: Array.isArray(c.waterWindows) ? c.waterWindows.slice() : ['12:00-14:00', '18:00-09:00'],
              // 0.9.0：主动搭话
              proactiveEnabled: c.proactiveEnabled === true,
              proactiveIdleHours: Number(c.proactiveIdleHours || 6),
              proactiveIdleMaxHours: Number(c.proactiveIdleMaxHours || 0),
              proactiveDailyMax: Number(c.proactiveDailyMax || 1),
              proactiveQuietFrom: String(c.proactiveQuietFrom || ''),
              proactiveQuietTo: String(c.proactiveQuietTo || ''),
              proactiveBackoffMax: Number(c.proactiveBackoffMax || 4),
              // 0.9.1：主动搭话的对象白名单（空 = 所有已绑私聊）
              proactiveTargets: Array.isArray(c.proactiveTargets) ? c.proactiveTargets.slice() : [],
              autoForwardReply: c.autoForwardReply !== false,
              backfillOnStart: c.backfillOnStart !== false,
              backfillMaxPages: Number(c.backfillMaxPages || 5),
              backfillDeliver: Number(c.backfillDeliver || 20),
              notifyTurnFailures: c.notifyTurnFailures !== false,
              voiceOutputDir: String(c.voiceOutputDir || ''),
              // 0.16.5：戳一戳（notice 事件，不是消息）
              pokeEnabled: c.pokeEnabled !== false,
              pokeCooldownMs: Number.isFinite(Number(c.pokeCooldownMs)) ? Number(c.pokeCooldownMs) : 10000,
              // 0.16.7：合并转发展开（聊天记录卡片）
              forwardExpandEnabled: c.forwardExpandEnabled !== false,
              forwardMaxDepth: Number.isFinite(Number(c.forwardMaxDepth)) ? Number(c.forwardMaxDepth) : 2,
              forwardMaxMessages: Number.isFinite(Number(c.forwardMaxMessages)) ? Number(c.forwardMaxMessages) : 50,
              forwardMaxChars: Number.isFinite(Number(c.forwardMaxChars)) ? Number(c.forwardMaxChars) : 2000,
              forwardImagesEnabled: c.forwardImagesEnabled === true,
              forwardImageLimit: Number.isFinite(Number(c.forwardImageLimit)) ? Number(c.forwardImageLimit) : 6,
              forwardTimeoutMs: Number.isFinite(Number(c.forwardTimeoutMs)) ? Number(c.forwardTimeoutMs) : 4000,
              forwardConcurrency: Number.isFinite(Number(c.forwardConcurrency)) ? Number(c.forwardConcurrency) : 3,
              forwardMaxRequests: Number.isFinite(Number(c.forwardMaxRequests)) ? Number(c.forwardMaxRequests) : 16,
              forwardBudgetMs: Number.isFinite(Number(c.forwardBudgetMs)) ? Number(c.forwardBudgetMs) : 6000,
              imageCopyDir: String(c.imageCopyDir || ''),
              textPrefix: String(c.textPrefix || ''),
              wsEnabled: c.wsEnabled !== false,
              wsUrl: String(c.wsUrl || ''),
              wsFallbackPollMs: Number(c.wsFallbackPollMs || 30000),
              // 0.15.0：HTTP API 地址（token 同样不回显，留空 = 保持原样）
              onebotHttp: String(c.onebotHttp || ''),
              // token 不回显：留空 = 保持原样（保存时不会误清掉）
              wsToken: '',
              token: '',
              // 0.17.4：工具箱分档（对象；缺键按默认补，别让 undefined 传到复选框上）
              toolFeatures: c.toolFeatures && typeof c.toolFeatures === 'object'
                ? {
                    silence: c.toolFeatures.silence !== false,
                    emoji: c.toolFeatures.emoji === true,
                    voiceIn: c.toolFeatures.voiceIn === true,
                    voiceOut: c.toolFeatures.voiceOut === true,
                    poke: c.toolFeatures.poke === true,
                  }
                : { silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false },
            })
            // 名单非空 = 只对选中的人；空 = 全员（跟着配置走，别自己猜）
            setTargetMode(Array.isArray(c.proactiveTargets) && c.proactiveTargets.length > 0 ? 'some' : 'all')
          })
          .catch(function (error) {
            setMsg('加载失败：' + errText(error))
          })
          .then(function () {
            setLoading(false)
          })
      }

      useEffect(function () {
        reload()
      }, [])

      /**
       * 工作区列表（0.18.4）。
       *
       * 和 /state 分开请求：注册表读不到时 /workspaces 返回空数组 + ok:true，
       * 后端 /state 里那 15 个工作区不该因为这一块挂了就整页拉不到。
       * 所以这里**自己吞错**，只把结果记进 state，绝不让它冒到渲染主路径上。
       */
      useEffect(function () {
        apiGet('/workspaces')
          .then(function (result) {
            var list = result !== null && result !== undefined && Array.isArray(result.workspaces)
              ? result.workspaces
              : []
            setWorkspaces({ ok: true, list: list })
          })
          .catch(function () {
            // 接口 404 / 网络断：降级成「手填路径」，但标记成降级态
            setWorkspaces({ ok: false, list: [] })
          })
      }, [])

      // 订阅浏览器端的会话列表：新开一个对话不用刷新页面就能在下拉里选到。
      // 注意：cordis 里没 inject 的服务读 ctx.xxx 会抛，必须整个包住，
      // 否则这一抛就把设置页干掉（React 的 effect 抛错会冒到边界之外）。
      useEffect(function () {
        try {
          var bridgeCtx = props !== null && props !== undefined ? props.bridgeCtx : undefined
          var sessionsSvc = bridgeCtx === null || bridgeCtx === undefined ? null : bridgeCtx.sessions
          var list = sessionsSvc === null || sessionsSvc === undefined ? null : sessionsSvc.list
          if (list === null || list === undefined || typeof list.subscribe !== 'function') return undefined
          var off = list.subscribe(function () {
            setTick(function (n) { return n + 1 })
          })
          return function () {
            if (typeof off === 'function') off()
          }
        } catch (error) {
          return undefined
        }
      }, [])

      function save() {
        // 「只对选中的人」但一个人都没勾 —— 后端用空数组表示「全员」，语义正好反过来。
        // 宁可拦住并说清楚，也别静默把配置改成她跟所有人都能搭话。
        if (targetMode === 'some' && Array.isArray(tunables && tunables.proactiveTargets) && tunables.proactiveTargets.length === 0) {
          setMsg('主动搭话选了「只对选中的人」，但一个都没勾：要么勾上人，要么切回「所有已绑私聊」。')
          return
        }
        setBusy(true)
        setMsg('')
        var payload = {
          routes: draft,
        }
        if (tunables !== null) {
          for (var key in tunables) {
            if (!Object.prototype.hasOwnProperty.call(tunables, key)) continue
            // token 留空 = 保持原样（后端不返回 token 明文，别把已有的清了）
            if (key === 'wsToken' && String(tunables[key] || '') === '') continue
            if (key === 'token' && String(tunables[key] || '') === '') continue
            // ⚠️ 0.18.4：工作区**不跟这个按钮走**，只由「绑定」页顶部的选择器提交。
            //   两条理由：
            //   ① 它要先按注册表校验。历史上配过一个不存在的路径（0.18.3 及以前），
            //      要是跟着这个按钮一起传，用户改个「分条字数」也会被 400 拦住，
            //      而且报的是工作区的错 —— 没人能想到这两件事有关系。
            //   ② 换工作区本来就要立刻刷新会话列表（见 pickWorkspace），
            //      跟「保存后再生效」是两种手感，混在一起只会互相拖累。
            if (key === 'workspaceCwd') continue
            payload[key] = tunables[key]
          }
          // 名单跟当前绑定对齐：解绑了的人留在名单里就是一串永远匹配不上的 key
          var picked = Array.isArray(tunables.proactiveTargets) ? tunables.proactiveTargets : []
          payload.proactiveTargets = targetMode === 'all'
            ? []
            : boundPrivateKeys().filter(function (k) { return picked.indexOf(k) >= 0 })
        }
        apiPost('/save', payload)
          .then(function () {
            // ⚠️ 0.17.4：工具箱的开关**不是**「下一轮生效」——
            //   工具注册发生在插件 apply 里，改完必须重启 DSH。
            //   原来这里只说一句「下一轮投递生效」，会跟工具箱卡片里那句「要重启」直接打架。
            setMsg('已保存。其余参数下一轮投递生效（推送链路会自己重连，不用重启）；'
              + '「工具箱」里改的开关要重启 DSH 才生效。')
          })
          .catch(function (error) {
            setMsg('保存失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function addRow(kind) {
        var raw = String(input[kind] || '').trim()
        if (raw === '') {
          setMsg('先填' + (kind === 'group' ? '群号' : 'QQ 号'))
          return
        }
        if (!/^\d{5,12}$/.test(raw)) {
          setMsg('号码格式不对：应该是 5~12 位数字')
          return
        }
        if (draft[kind][raw] !== undefined) {
          setMsg('这个号已经在列表里了')
          return
        }
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][raw] = { sessionId: '', prefix: '' }
        setDraft(next)
        var nextInput = Object.assign({}, input)
        nextInput[kind] = ''
        setInput(nextInput)
        setMsg('已添加，记得选会话再保存')
      }

      function removeRow(kind, id) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        delete next[kind][id]
        setDraft(next)
        setMsg('已移除，保存后生效')
      }

      function setSession(kind, id, sessionId) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][id] = Object.assign({}, next[kind][id], { sessionId: sessionId })
        setDraft(next)
      }

      /**
       * 这一路投递时正文前那行前缀（比如「（QQ 私聊）」）。
       * 以前设置页没有输入框，保存时又会被清洗掉空串 —— 配过的自定义前缀
       * 点一次「保存」就悄悄没了。现在给它一个格子，能改也能留空。
       */
      function setPrefixOf(kind, id, prefix) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][id] = Object.assign({}, next[kind][id], { prefix: prefix })
        setDraft(next)
      }

      function nameOf(kind, id) {
        if (!data) return ''
        var pool = kind === 'group' ? data.groups : data.friends
        if (!Array.isArray(pool)) return ''
        for (var i = 0; i < pool.length; i++) {
          if (String(pool[i].id) === String(id)) return String(pool[i].name || '')
        }
        return ''
      }

      /**
       * 有会话的私聊 key（`private:uin`）—— 主动搭话只能对这些人开口。
       * 用 draft 而不是 data.routes：用户刚在「绑定」里加的、还没保存的也要能选。
       */
      function boundPrivateKeys() {
        var out = []
        var table = draft.private || {}
        for (var uin in table) {
          if (!Object.prototype.hasOwnProperty.call(table, uin)) continue
          var route = table[uin]
          if (String(route && route.sessionId ? route.sessionId : '') === '') continue
          out.push('private:' + uin)
        }
        return out
      }

      function pickedTargets() {
        return tunables !== null && Array.isArray(tunables.proactiveTargets) ? tunables.proactiveTargets : []
      }

      function setTargets(list) {
        if (tunables === null) return
        var next = Object.assign({}, tunables)
        next.proactiveTargets = list
        setTunables(next)
      }

      /**
       * 勾 / 取消一个人的主动资格。
       * 空数组的语义是「全员」，所以从全员状态取消一个人时要先展开成显式名单，
       * 否则「取消 A」会被后端理解成「谁都可以」—— 正好反了。
       */
      function toggleTarget(key, on) {
        var all = boundPrivateKeys()
        var cur = pickedTargets()
        if (cur.length === 0) cur = all.slice()
        var next = on === true
          ? (cur.indexOf(key) >= 0 ? cur : cur.concat([key]))
          : cur.filter(function (k) { return k !== key })
        // 顺序跟绑定表对齐，顺手丢掉已经不存在的 key
        setTargets(all.filter(function (k) { return next.indexOf(k) >= 0 }))
      }

      function switchTargetMode(mode) {
        setTargetMode(mode)
        if (mode === 'all') {
          setTargets([])
          return
        }
        // 切到「指定的人」时先把全员填进去：否则一进来就是空名单，保存会被拦，看着像坏了
        if (pickedTargets().length === 0) setTargets(boundPrivateKeys())
      }

      if (loading === true && data === null) {
        return h('div', { className: 'qqb-wrap' }, h('div', { className: 'qqb-note' }, '加载中…'))
      }

      if (data === null) {
        return h('div', { className: 'qqb-wrap' }, [
          h('div', { className: 'qqb-title', key: 't' }, 'QQ 桥接'),
          h('div', { className: 'qqb-err', key: 'e' }, msg || '加载失败'),
          h('button', { className: 'qqb-btn', key: 'b', onClick: reload }, '重试'),
        ])
      }

      var bridgeCtx = props !== null && props !== undefined ? props.bridgeCtx : undefined
      /**
       * 当前工作区。
       *
       * 优先取表单状态 `tunables.workspaceCwd`：它是 reload 从 /state 回填、
       * 以及 pickWorkspace 切换成功后立刻更新的那份 —— 切换失败时不会变，
       * 于是下拉框会停在上一个有效值上（而不是显示一个根本没存进去的路径）。
       * 表单状态还没有（首屏 tunables 为 null）时退回 /state 里那份。
       */
      var wantCwd = String(
        tunables !== null && tunables !== undefined && typeof tunables.workspaceCwd === 'string'
          ? tunables.workspaceCwd
          : (data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '')
      )
      var sessions = mergeSessions(
        Array.isArray(data.sessions) ? data.sessions : [],
        clientSessions(bridgeCtx, wantCwd)
      )

      /** 注册表里的工作区列表（降级时是空数组）。 */
      var wsList = workspaces !== null && workspaces !== undefined && Array.isArray(workspaces.list)
        ? workspaces.list
        : []
      /** 按路径找工作区（大小写/斜杠方向不敏感），找不到就 undefined。 */
      function findWorkspace(cwd) {
        var want = normCwd(cwd)
        if (want === '') return undefined
        for (var i = 0; i < wsList.length; i++) {
          if (normCwd(wsList[i].path) === want) return wsList[i]
        }
        return undefined
      }
      /** 当前工作区的显示名：优先标题，其次路径，都没有就说「未设置」。 */
      function currentWorkspaceLabel() {
        if (wantCwd === '') return '（未设置：不筛工作区）'
        var hit = findWorkspace(wantCwd)
        if (hit !== undefined) return String(hit.title || hit.path || wantCwd)
        return wantCwd + '（不在注册表里，请重新选）'
      }

      /**
       * 换工作区（0.18.4）。选中即保存，不跟「保存」按钮一起走。
       *
       * 为什么不复用 save()：那个按钮会把整份 draft（绑定表）+ tunables 一起提交，
       * 用户只是换个工作区却顺手把没想好的绑定改动也写进去了。
       * 这里只提交 workspaceCwd 一个字段 —— 后端 /save 是部分更新，别的键不动。
       *
       * 换完之后**立刻重新载入**：会话列表是按工作区筛的，不重载就会拿着旧列表选会话，
       * 选出来的 id 属于另一个工作区（这正是这个功能原来坏掉时的样子）。
       */
      function pickWorkspace(cwd) {
        var raw = String(cwd || '').trim()
        // 没变化就别走一趟保存 + 重载（手填输入框失焦时最容易触发）
        if (raw === wantCwd) return
        setBusy(true)
        setMsg('')
        apiPost('/save', { workspaceCwd: raw })
          .then(function () {
            return apiGet('/state')
          })
          .then(function (result) {
            setData(result)
            // 顺带把表单状态也同步过去：wantCwd 优先读它，
            // 不同步的话下拉框会停在旧值上（看着像"没切换成功"）。
            var next = result && result.config ? String(result.config.workspaceCwd || '') : ''
            setTunables(function (old) {
              return Object.assign({}, old, { workspaceCwd: next })
            })
            setMsg('工作区已切换：' + (raw === '' ? '不筛（列出全部会话）' : raw) + '。会话列表已刷新，请重新选择要绑定的会话。')
          })
          .catch(function (error) {
            // 后端会 400（路径不在注册表里），把后端那句话原样转给用户 —— 别自己编一句
            setMsg('切换工作区失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      /**
       * 「绑定」页顶部的工作区选择器（0.18.4）。
       *
       * 三种形态，都别让页面变成空白：
       *   ① 注册表读到了 → 下拉框（选项是标题，hover 看完整路径）
       *   ② 注册表读不到（接口 404 / 文件缺失 / 坏 JSON）→ 手填输入框 + 一句说明
       *   ③ 还没问完（null）→ 一行「正在读取工作区…」
       *
       * ⚠️ 当前值不在注册表里时（老配置、或工作区被删了），下拉框也要给它留一条 option。
       *   不给的话 select 找不到匹配项只会显示第一项，用户以为已经换过去了。
       */
      function renderWorkspacePicker() {
        var cur = wantCwd
        var known = findWorkspace(cur)
        var degraded = workspaces !== null && workspaces !== undefined && workspaces.ok === false

        var control
        if (workspaces === null || workspaces === undefined) {
          control = h('span', { className: 'qqb-note', key: 'w' }, '正在读取工作区…')
        } else if (degraded || wsList.length === 0) {
          // 降级：手填。留空 = 不筛工作区（列出全部会话）。
          // 只在 blur 时提交 —— 否则每敲一个字符就 /save + 重载一次，
          // 而且中间态（只打了个 "D"）必然被后端 400 打回来。
          control = h('input', {
            className: 'qqb-input',
            key: 'w',
            style: { maxWidth: '420px' },
            type: 'text',
            placeholder: '工作区路径，留空 = 不筛（列出全部会话）',
            defaultValue: cur,
            disabled: busy,
            onBlur: function (event) { pickWorkspace(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') pickWorkspace(event.target.value)
            },
          })
        } else {
          control = h('select', {
            className: 'qqb-select',
            key: 'w',
            style: { maxWidth: '420px' },
            value: cur,
            disabled: busy,
            onChange: function (event) { pickWorkspace(event.target.value) },
          }, [
            h('option', { value: '', key: 'none' }, '（不筛工作区，列出全部会话）'),
          ].concat(
            // 当前值不在注册表里：留一条占位项，别让它静默跳到第一项
            cur !== '' && known === undefined
              ? [h('option', { value: cur, key: 'stale' }, cur + '（不在工作区注册表里）')]
              : []
          ).concat(wsList.map(function (item) {
            return h('option', {
              value: item.path,
              key: item.id || item.path,
              title: item.path,
            }, String(item.title || item.path) + '（' + String(Number(item.sessionCount) || 0) + ' 个会话）')
          })))
        }

        return h('div', { className: 'qqb-card', key: 'workspace' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '会话来源工作区'),
            h('span', { className: 'qqb-note', key: 'n' }, sessions.length + ' 个可选会话'),
          ]),
          h('div', { className: 'qqb-tools', key: 'b' }, [
            control,
            h('span', { className: 'qqb-note', key: 'd', style: { flex: '1 1 260px' } },
              degraded
                ? '读不到工作区注册表（~/.dsh/storages/workspace.json），只能手填路径；填完立刻保存并刷新会话列表。'
                : '只列这个工作区里的会话。换工作区后要重新选会话 —— 会话 id 跨工作区不通用。'),
          ]),
          // 图片副本的副作用必须说出来：换工作区 = 「收到的图片」目录也跟着搬。
          h('div', { className: 'qqb-tools', key: 'img', style: { borderTop: '0', paddingTop: '0' } }, [
            h('span', { className: 'qqb-note', key: 'i' },
              '注意：收到的图片副本存在「<工作区>\\收到的图片」下，换工作区 = 以后的新图存到新目录，'
              + '旧目录里的图不会跟着搬（要固定位置就把「高级 → 图片副本目录」填死）。'),
          ]),
        ])
      }

      function renderTable(kind, title, idLabel) {
        var rows = Object.keys(draft[kind] || {})
        var head = h('div', { className: 'qqb-card-head', key: 'h' }, [
          h('span', { className: 'qqb-card-title', key: 't' }, title),
          h('span', { className: 'qqb-note', key: 'n' }, sessions.length + ' 个可选会话'),
        ])
        // 这张卡片第一眼就要回答「这一行是干什么的、那个前缀是什么」。
        // 以前的答案只在 input 的 title 里（要悬停才看得见），等于没写。
        var legend = h('div', { className: 'qqb-note', key: 'legend', style: { padding: '8px 12px 0' } },
          kind === 'private'
            ? '这一行 = 某个 QQ 好友 → 绑到哪个 DSH 会话。「前缀」是她收到这个人消息时，正文前那行来源标记'
              + '（留空 = 用「高级」里的私聊默认前缀）。它只影响她看到的字，不影响发出去的内容。'
            : '这一行 = 某个 QQ 群 → 绑到哪个 DSH 会话。群里的消息要 @ 她才会投递（除非在「高级」里关掉「只在 @ 时响应」）。'
              + '群聊不需要前缀：群头由插件按发送者身份自动拼，作用是让她分得清哪句是群友说的。')

        var body = rows.length === 0
          ? [h('div', { className: 'qqb-empty', key: 'empty' }, '还没有绑定任何' + (kind === 'group' ? '群' : '好友') + '。没绑定的号发来的消息会被忽略。')]
          : rows.map(function (id) {
            var route = draft[kind][id] || {}
            var current = String(route.sessionId || '')
            var name = nameOf(kind, id)
            return h('div', { className: 'qqb-row', key: kind + id }, [
              h('span', { className: 'qqb-uin', key: 'i' }, id),
              h('span', { className: 'qqb-name', key: 'n', title: name }, name === '' ? '（未知）' : name),
              h('select', {
                className: 'qqb-select',
                key: 's',
                value: current,
                onChange: function (event) {
                  setSession(kind, id, event.target.value)
                },
              }, [
                h('option', { value: '', key: '' }, '— 未绑定（忽略）—'),
              ].concat(
                // 已绑定但不在当前列表里（被删了 / 换了工作区）时，也给它一条 option，
                // 否则 select 找不到匹配项，只能显示第一项，还带个警告三角
                current !== '' && sessions.every(function (s) { return s.id !== current })
                  ? [h('option', { value: current, key: 'stale' }, sessionLabel({ id: current, title: '' }) + '（不在当前工作区）')]
                  : []
              ).concat(sessions.map(function (session) {
                return h('option', { value: session.id, key: session.id }, sessionLabel(session))
              }))),
              // ⚠️ 群聊**没有**可自定义的前缀（2026-11-06）。
              //   群头是插件按发送者身份自动拼的：
              //   （QQ群 975663147「群名」·群友「暮秋槐」（QQ 107…，不是用户本人））
              //   以前这里照样给群表渲染输入框、api.js 也照存 —— 但群路径从不读
              //   route.prefix（全仓库只有 poll.js 的私聊路径调 prefixOf），填了等于没填。
              //   让用户以为能改、实际不生效，比不给控件坏得多，所以撤掉。
              //   留一个占位 span 撑住 grid 的第 4 列，否则「移除」按钮会串到前缀那格。
              kind === 'private'
                ? h('input', {
                  className: 'qqb-input',
                  key: 'p',
                  type: 'text',
                  title: '只对私聊生效：投递时正文前那行字，留空 = 用「高级」里的私聊默认前缀',
                  placeholder: '前缀（可选）',
                  value: String(route.prefix || ''),
                  onChange: function (event) { setPrefixOf(kind, id, event.target.value) },
                })
                : h('span', {
                  className: 'qqb-note',
                  key: 'p',
                  title: '群聊不需要前缀：群头（QQ群 号「群名」·群友「谁」（QQ 号，不是用户本人））'
                    + '由插件按发送者身份自动生成，作用是不让她把群友的话当成你说的话。',
                }, '群头自动生成'),
              h('span', { key: 'a', style: { display: 'flex', gap: '6px' } }, [
                h('button', {
                  className: 'qqb-btn danger',
                  key: 'del',
                  onClick: function () { removeRow(kind, id) },
                }, '移除'),
              ]),
            ])
          })

        var adder = h('div', { className: 'qqb-tools', key: 'add' }, [
          h('input', {
            className: 'qqb-input',
            key: 'in',
            style: { width: '180px' },
            placeholder: idLabel,
            value: input[kind],
            onChange: function (event) {
              var next = Object.assign({}, input)
              next[kind] = event.target.value
              setInput(next)
            },
          }),
          h('button', { className: 'qqb-btn', key: 'add', onClick: function () { addRow(kind) } }, '添加'),
        ])

        return h('div', { className: 'qqb-card', key: kind }, [head, legend].concat(body, [adder]))
      }

      /**
       * 通用字段改动处理。
       * 只有 number 类型才转数字；文本框直接存字符串
       * （以前一律 Number()，文本框填地址会变成 NaN）。
       * 放在组件层，renderAdvanced / renderWs 都要用。
       */
      function onField(key) {
        return function (event) {
          var next = Object.assign({}, tunables)
          next[key] = event.target.type === 'checkbox'
            ? event.target.checked === true
            : (event.target.type === 'number' ? Number(event.target.value) : event.target.value)
          setTunables(next)
        }
      }

      /**
       * 嵌套对象字段（toolFeatures）的开关处理（0.17.4）。
       * onField 只改顶层键，对 toolFeatures.silence 这种路径会把整个对象替换成 true —— 必须单独一个。
       */
      function onFeature(key) {
        return function (event) {
          var next = Object.assign({}, tunables)
          next.toolFeatures = Object.assign({}, next.toolFeatures)
          next.toolFeatures[key] = event.target.checked === true
          setTunables(next)
        }
      }

      /**
       * 纯文本字段 —— 提到组件层，因为**多个卡片都要用**（2026-11-05 教训）。
       *
       * ⚠️ 原来它在 renderAdvanced / renderProactive 里各定义了一份（局部函数）。
       *   我在 renderStance 里调用它时没注意作用域，直接 `ReferenceError: textField is not defined`，
       *   而抛点在 QqBridgeSection 的渲染主路径上 —— **整块设置页白屏**，不是少一个控件。
       *   （踩坑记录坑 15/16 说的就是这个：渲染期抛错 = 白屏。）
       *   所以凡是「两个以上卡片要用」的字段构造函数，一律放这一层，别再各写一份。
       */
      function textField(key, label, placeholder, hint) {
        var t = tunables
        if (t === null) return null
        return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
          h('span', { className: 'qqb-field-label', key: 'l' }, label),
          h('input', {
            className: 'qqb-input',
            key: 'i',
            type: 'text',
            placeholder: placeholder || '',
            value: t[key] || '',
            onChange: onField(key),
          }),
        ])
      }

      function renderAdvanced() {
        var t = tunables
        if (t === null) return null

        function numberField(key, label, unit, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: 0,
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        function boolField(key, label, hint) {
          return h('label', { className: 'qqb-check', key: key, title: hint || '' }, [
            h('input', { type: 'checkbox', key: 'c', checked: t[key] === true, onChange: onField(key) }),
            h('span', { key: 'l' }, label),
          ])
        }

        // textField 已提到组件层（见 onField 下方）—— 别在这里再定义一份，
        // 局部同名函数会遮蔽它，以后又会出现「这个卡片里能用、那个卡片里崩」。

        return h('div', { className: 'qqb-card', key: 'advanced' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '高级设置'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '改完点上面的「保存」'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            numberField('groupContextCount', '群聊上下文', '条', '被 @ 时附带前面几条群消息当上下文，0 = 不带'),
            numberField('splitMaxChars', '每段最多', '字', '分条发送时单条最多多少字'),
            numberField('splitMaxParts', '最多几条', '条', '一次回复最多拆几条，超出的合并。填 1 = 强制只发一条（不管怎么切）'),
            numberField('splitMinChars', '碎片阈值', '字', '小于这个字数的碎片并进相邻一条，避免「嗯。」单独成条'),
            numberField('splitDelayMinMs', '间隔最小', 'ms', '分条之间最少等多久'),
            numberField('splitDelayMaxMs', '间隔最大', 'ms', '分条之间最多等多久'),
            numberField('pollMs', '私聊轮询', 'ms', '多久拉一次私聊消息（WS 正常时降为下面的补漏间隔）'),
            numberField('groupPollMs', '群聊轮询', 'ms', '多久拉一次群消息'),
            numberField('wsFallbackPollMs', '推送时补漏', 'ms', 'WS 正常时的低频轮询，防漏事件；WS 断开自动回到「私聊轮询」'),
            textField('textPrefix', '私聊默认前缀', '（QQ 私聊）', '**只对私聊生效**。没在上面的绑定表里单独填前缀的好友，就用这里的值。'
              + '实际投递时插件会在后面接上身份标记，最终长这样：（QQ 私聊·用户本人 QQ 1321833118）晚上好啊 —— '
              + '所以这里最好以「）」结尾，否则会拼成（QQ 私聊·用户本人 QQ 123）这种缺括号的样子。'
              + '群聊不受它影响（群头由插件按发送者身份自动生成）。'),
            textField('imageCopyDir', '图片副本目录', '留空 = 工作区\\收到的图片', '收到图片时另存一份人能看的副本；填 off 就不存'),
            textField('voiceOutputDir', '语音产物目录', '留空 = ~/.dsh/voice（自动创建）', '只允许从该目录发送本机语音文件，目录外的路径会被拒绝。'
              + '留空就用默认位置：数据目录下的 voice（~/.dsh/voice），不存在会自动创建。'
              + '填 off 才真正关掉语音发送。'),
            // 语音这块以前默认是「坏的」：留空等于拒绝读任何本机文件，
            // 用户不先来这填一个目录，发语音就永远失败，而界面上只写着「留空 = 禁止」。
            //
            // 默认位置**故意不落工作区**（2026-11-06 审核后改）：工作区是 agent
            // 自己可写的地方，默认目录落在那儿等于给它一条「自己写文件、自己念出来
            // 发出去」的旁路 —— 语音出口不做文字敏感词审计（现在补了一道内容扫描，
            // 但那是兜底，不该当成唯一防线）。
            h('div', {
              className: 'qqb-note',
              key: 'voice-help',
              style: { gridColumn: '1 / -1' },
            }, '安全边界：目录外的文件、指向目录外的链接（含 Windows junction）、内容和扩展名对不上的、'
              + '超过 20MB 的、内容里含本机路径或凭据特征的、一分钟内第 6 次发送尝试，全部会被拒绝。'),
            boolField('groupOnlyWhenAt', '群里只在 @ 时响应', '关掉后群里每条消息都投递'),
            boolField('splitReply', '按标点自动分条', '长回复切成多条再发。'
              + '⚠️ 关掉它就只剩一条（整段发出去）；但模型自己传了 segments 时以它为准，不受这里影响。'),
            boolField('resumeColdSession', '会话没打开时自动冷启动', '关掉后只有开着的会话才收消息'),
            // 这一格回答「前缀到底有几个、分别管什么」。
            // 三处都叫「前缀」，但作用域完全不同，以前全靠悬停 title 才看得见 —— 等于没说。
            h('div', {
              className: 'qqb-note',
              key: 'prefix-help',
              style: { gridColumn: '1 / -1', borderTop: '1px solid var(--dsw-alias-border-l1,#eef0f3)', paddingTop: '8px' },
            }, [
              h('div', { key: 'h' }, '这一页有两个「前缀」，别混了：'),
              h('div', { key: 'a' }, '① 私聊默认前缀 —— 就是上面那一格，管所有没单独填过前缀的好友。'
                + '效果是「她收到消息时，正文前多一行来源标记」，只影响她读到的内容，不影响发出去的话。'
                + '填「（QQ 私聊）」→ 她看到的是「（QQ 私聊·用户本人 QQ 你的号）晚上好啊」；'
                + '填「【阿明】」→ 会拼成「【阿明】·用户本人 QQ 你的号）」，括号只剩半边，所以建议以「）」结尾。'),
              h('div', { key: 'b' }, '② 绑定表里的前缀 —— 只管那一个好友，填了就盖掉 ①。群聊没有这个格子：'
                + '群头（QQ群 号「群名」·群友「谁」（QQ 号，不是用户本人））由插件按发送者身份自动拼，'
                + '作用是让她分得清哪句是你说的、哪句是群友说的，所以不需要你配。'),
              h('div', { key: 'c' }, '另外「对话节奏」里那个「命令前缀」（/进度、/去 3）是第三样东西 —— '
                + '它管的是你发的命令，跟上面两个没关系。'),
            ]),
          ]),
        ])
      }

      /**
       * 对话节奏 —— 0.7.1 的「沉默权」旋钮。
       * 这些以前只在配置文件里，用户想调手感得手改 JSON。放进界面才算真能用。
       */
      function renderStance() {
        var t = tunables
        if (t === null) return null

        function numberField(key, label, unit, hint, placeholder) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: 0,
              placeholder: placeholder || '',
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        function boolField(key, label, hint) {
          return h('label', { className: 'qqb-check', key: key, title: hint || '' }, [
            h('input', { type: 'checkbox', key: 'c', checked: t[key] === true, onChange: onField(key) }),
            h('span', { key: 'l' }, label),
          ])
        }

        /** 下拉选择：分条依据这种「只能从几个值里挑一个」的字段。 */
        function selectField(key, label, options, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('select', {
              className: 'qqb-select',
              key: 'i',
              value: t[key],
              onChange: onField(key),
            }, options.map(function (item) {
              return h('option', { value: item[0], key: item[0] }, item[1])
            })),
          ])
        }

        return h('div', { className: 'qqb-card', key: 'stance' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '对话节奏'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '她什么时候开口、愿意等多久'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            // 分条这块有三个互相影响的旋钮，以前每个只说自己、不提前提，
            // 结果用户想「只发一条」时不知道到底该动哪个。这里按优先级写清楚。
            h('div', {
              className: 'qqb-note',
              key: 'split-help',
              style: { gridColumn: '1 / -1', borderTop: '1px solid var(--dsw-alias-border-l1,#eef0f3)', paddingTop: '8px' },
            }, [
              h('div', { key: 'h' }, '想让她「一口气只发一条」，按这个顺序看：'),
              h('div', { key: 'a' }, '① 先看下面「按标点自动分条」关没关 —— 关掉就是整段一条，这一步最直接。'),
              h('div', { key: 'b' }, '② 开着的话，「怎么分条」决定切点：按换行 = 她写几行发几条；'
                + '按句末标点 = 每个。！？都拆一条（这是老行为，也是最容易被当成「分条关不掉」的那个）。'),
              h('div', { key: 'c' }, '③ 「最多几条」是硬上限：填 1 时上面两步的切分结果会被合并成一条。'
                + '所以只要填 1，无论怎么切最后都只发一条。'),
              h('div', { key: 'd' }, '⚠️ 唯一的例外：模型调 qq_send 时自己传了 segments（她主动决定分几条），'
                + '那时以上三个都不生效 —— 那是她自己的表达意图，不是配置能覆盖的。'),
            ]),
            selectField('splitMode', '怎么分条', [
              ['paragraph', '按换行分（她自己决定说几条）'],
              ['sentence', '按句末标点切（老行为，一句一条）'],
            ], '按换行：她写几行就发几条，句号不算分条；按标点：每个。！？都拆一条，像真人一句句打出来。改完下一轮生效'),
            numberField('replyQuietMs', '回复前静默', 'ms', '收到消息后先等够这么久再交给模型，让她看起来在「看手机」而不是秒回。0 = 关。建议试 5000，总预算 60 秒封顶（防刷屏）'),
            numberField('mergeWindowMs', '合并窗口', 'ms', '私聊连发几条时先攒一会儿再一起回（「标记已读」的中间态：先记账，不立刻开回合）。0 = 关，回到来一条回一条。跟「回复前静默」会叠加，两个都开时延迟相加'),
            numberField('mergeMaxWaitMs', '合并上限', 'ms', '最多攒这么久就强制放行 —— 对方一直发也不能无限等'),
            numberField('mergeMaxMessages', '合并条数', '条', '池里攒到这么多条立刻放行，一口气十条已经不算「还没说完」'),
            boolField('windowEnabled', '允许 @ 之后继续聊', '群里 @ 她后开启限时连续对话窗口'),
            numberField('windowIdleMs', '窗口静默', 'ms', '窗口多久没有新消息后自动关闭（默认 2 分钟）'),
            numberField('windowMaxReplies', '单窗最多回复', '句', '一个对话窗口最多回复几次'),
            numberField('windowPerPeerDaily', '每人每日开窗', '个', '同一位群友每天最多开启的窗口数'),
            numberField('windowPerGroupDaily', '每群每日开窗', '个', '每个群每天最多开启的窗口数'),
            numberField('windowMaxMs', '窗口硬上限', 'ms', '从开窗起的最长时长（默认 10 分钟）'),
            numberField('waitMaxMs', '等待上限', 'ms', 'qq_wait 一次最多等多久'),
            numberField('waitTurnMaxMs', '单回合等待总量', 'ms', '一个回合里 qq_wait 累计最多等多久（0 = 不限）。回合越长，这期间新来的消息排队越久 —— 所以除了「一次上限」还要有「总量上限」。有新消息投给她时自动重置'),
            boolField('pokeEnabled', '被戳时接话', '群里有人戳她（双击头像）时也起一轮 —— 戳一戳走得比消息轻，只回一句'),
            numberField('pokeCooldownMs', '戳一戳冷却', 'ms', '同一处（群按群算、私聊按人算）在这段时间内被连戳只回一次。0 = 不限（不建议：被戳一下就回一句会变成刷屏机器）'),
            boolField('notifyTurnFailures', '回合故障时发系统通知', '回合出错或中断时，由插件发一条带 [系统] 的说明。关闭后故障只记日志，不会替模型发消息。'),
            // ---- 0.17.5：跨工作区会话进度（2026-11-05）----
            // 这五项调的是「QQ 里的命令」和「进度列表怎么显示」，属于手感类，
            // 所以放进「对话节奏」这张卡，不单开一栏（设置页已有 7 个标签，窄窗口很挤）。
            textField('qqCommandPrefix', '命令前缀', 'QQ 里发 /进度、/去 3 这类命令的前缀。**留空 = 完全关闭命令层**（所有消息照旧投给会话）。改成别的符号也行，比如 ! 或 #'),
            boolField('focusTagEnabled', '多会话时给回复加标签', '当你的话被投给「非默认绑定」的会话时，它的回复前面会带一个 〔工作区·会话〕 小标签，方便分清哪句是哪边说的。日常单会话聊天不会出现标签'),
            numberField('focusIdleResetMs', '焦点闲置多久自动回默认', 'ms', '用 /去 切过焦点后，这么久没说话就自动回到默认绑定的会话，避免「昨天切到 A，今天发消息还进 A」。0 = 永不自动回'),
            numberField('progressMaxRows', '进度最多列几行', '行', '/进度 一次最多显示多少个会话。太多刷屏，太少又得反复翻'),
            numberField('progressIdleWindowMs', '「最近活跃」取多久以内', 'ms', '/进度 里「最近活跃」那组的取样时间窗。默认 24 小时；只看在跑的就调小'),
            boolField('closureEnabled', '允许判断收尾', '开着才会在双方都收尾时用 qq_close 结束会话；对方还有问题没答时会硬判继续。卡在收尾上时临时关掉'),
            boolField('autoForwardReply', '自动转发回复', '回合结束后把最终回复自动发回 QQ，不依赖 qq_send'),
            boolField('backfillOnStart', '上线补历史', '掉线期间攒的消息按游标翻回来（每页 50 条），否则超过 10 条会永久丢'),
            numberField('backfillMaxPages', '补历史最多', '页', '每个对象最多往回翻几页'),
            numberField('backfillDeliver', '补历史投递', '条', '超出的只报数不展开，避免灌爆上下文'),
            boolField('forwardExpandEnabled', '读聊天记录卡片', '别人转发一段「群聊的聊天记录」时，把里面的消息展开给她看。关掉的话她只能看到「[转发消息]」占位 —— 等于读不到内容'),
            numberField('forwardMaxDepth', '卡片展开层数', '层', '0 = 不展开（只留占位），1 = 只展开最外层，2 = 连里面的转发也展开（默认），再大就继续往里钻。没有硬上限 —— 层数越大请求越多、上下文越贵，成本自己权衡'),
            numberField('forwardMaxMessages', '卡片最多条数', '条', '一张卡片最多展开多少条消息，超出部分会写明「还有 N 条未展开」'),
            numberField('forwardMaxChars', '卡片最多字数', '字', '一张卡片最多展开多少字，超出就截断并说明还漏了多少条'),
            boolField('forwardImagesEnabled', '卡片里的图也下载', '卡片里的图片也存进附件库给她看。关掉则图只显示「[图片]」—— 一张卡片可能有十几张图，默认关着省流量'),
            numberField('forwardImageLimit', '卡片图片上限', '张', '开着「卡片里的图也下载」时，一次投递最多取几张'),
            numberField('forwardTimeoutMs', '卡片展开超时', 'ms', '单张卡片多久取不回来就放弃 —— 它卡住会拖慢整条投递，所以比全局 8 秒短'),
            numberField('forwardConcurrency', '卡片并发数', '张', '一次投递里最多**同时**展开几张卡片（不是总数上限，所有卡片最终都会取到）'),
            numberField('forwardMaxRequests', '展开请求上限', '次', '一次投递最多发几个展开请求。这是防止「层数调很大 + 嵌套多」时请求成倍增长、把群投递拖停的安全阀；超出的卡片按占位显示'),
            numberField('forwardBudgetMs', '展开时间预算', 'ms', '一次投递里展开最多花多久，超了就收摊。卡片读不到只是占位，但不能因为它让整条消息延迟太久'),
          ]),
        ])
      }

      /** 主动搭话为什么没说 —— 把后端的 reason 翻成人话（排障时不用去翻源码）。 */
      function reasonText(reason) {
        var map = {
          off: '开关关着',
          'quiet-hours': '静默时段',
          'never-talked': '还没来往过',
          'daily-quota': '今天的次数用完了',
          'not-idle-enough': '还没到空闲时长',
          backoff: '上次主动没被回，正在退避',
          force: '手动触发',
          ok: '现在可以开口',
          'deliver-failed': '没找到可用会话',
          'not-bound': '没绑会话或不在主动名单里',
        }
        return map[String(reason || '')] || String(reason || '')
      }

      function fmtWhen(ms) {
        var n = Number(ms) || 0
        if (n <= 0) return '—'
        var d = new Date(n)
        var pad = function (v) { return (v < 10 ? '0' : '') + v }
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      }

      /**
       * 主动搭话（0.9.0）—— 没人叫她时，她自己想起来找你。
       * 这一层最容易做错：写成「定时问候」就毁了她。所以四道闸全部可见、可调。
       *
       * 0.9.1 起分两张卡：上面是「怎么开口」（节奏与闸），下面是「对谁开口」（名单）。
       * 选人单独一张卡 —— 混在一堆数字里没人看得见，而「只对谁开口」恰恰是最该先定的事。
       */
      function renderProactive() {
        var t = tunables
        if (t === null) return null
        var pro = data && data.proactive ? data.proactive : null
        var peers = pro !== null && Array.isArray(pro.peers) ? pro.peers : []

        // 状态按 key 索引：名单里每个人都能查到「上次什么时候开的口 / 今天几次 / 为什么还不出声」
        var stateOf = {}
        for (var i = 0; i < peers.length; i++) {
          var item = peers[i]
          if (item !== null && item !== undefined && item.key !== undefined) stateOf[String(item.key)] = item
        }

        var bound = boundPrivateKeys()
        var picked = pickedTargets()
        var allMode = targetMode !== 'some'

        function numberField(key, label, unit, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: 0,
              step: key === 'proactiveIdleHours' ? 0.5 : 1,
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        // textField 已提到组件层（见 onField 下方）—— 别再定义局部副本。

        function modeRadio(mode, label, hint) {
          return h('label', { className: 'qqb-check', key: 'm-' + mode, title: hint }, [
            h('input', {
              type: 'radio',
              key: 'r',
              name: 'qqb-proactive-mode',
              checked: (mode === 'all') === allMode,
              onChange: function () { switchTargetMode(mode) },
            }),
            h('span', { key: 'l' }, label),
          ])
        }

        var targetRows
        if (bound.length === 0) {
          targetRows = [h('div', { className: 'qqb-empty', key: 'empty' }, '还没有绑好会话的私聊。先到「绑定」里给某个人选一个会话，再回来决定对谁开口。')]
        } else {
          targetRows = bound.map(function (key) {
            var uin = key.slice('private:'.length)
            var st = stateOf[key] || null
            var name = nameOf('private', uin)
            var on = allMode ? true : picked.indexOf(key) >= 0
            var status = st === null
              ? '还没来往过（从没收到过他的消息）'
              : '上次主动 ' + fmtWhen(st.lastProactiveAt) + ' · 收到消息 ' + fmtWhen(st.lastIncomingAt) +
                ' · 今天 ' + String(st.countToday) + ' 次 · ' + reasonText(st.reason)
            return h('div', { className: 'qqb-tgt-row', key: key }, [
              h('input', {
                type: 'checkbox',
                key: 'c',
                checked: on,
                title: allMode ? '现在是「所有已绑私聊」，取消勾选会自动切到「只对选中的人」' : '',
                onChange: function (event) {
                  // 全员模式下取消一个人 = 把名单展开成「除他以外的所有人」
                  if (allMode) setTargetMode('some')
                  toggleTarget(key, event.target.checked === true)
                },
              }),
              h('span', { className: 'qqb-uin', key: 'u' }, uin),
              h('div', { className: 'qqb-tgt-main', key: 'm' }, [
                h('span', { className: 'qqb-name', key: 'n', title: name }, name === '' ? '（未知）' : name),
                h('span', { className: 'qqb-hint-inline', key: 's' }, status),
              ]),
              h('button', {
                className: 'qqb-btn',
                key: 'try',
                disabled: busy,
                title: '对这个人立刻试一次（跳过开关和所有闸，说不说仍由她定）',
                onClick: function () { runProactiveNow(key) },
              }, '对TA试一次'),
            ])
          })
        }

        return h('div', { className: 'qqb-pane', key: 'proactive' }, [
          h('div', { className: 'qqb-card', key: 'knobs' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '主动搭话'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, '没人叫她时，她自己想起来找你'),
            ]),
            h('div', { className: 'qqb-adv', key: 'b' }, [
              h('label', { className: 'qqb-check', key: 'en', title: '打开后每 60 秒看一次该不该开口；关着时完全不发任何消息' }, [
                h('input', { type: 'checkbox', key: 'c', checked: t.proactiveEnabled === true, onChange: onField('proactiveEnabled') }),
                h('span', { key: 'l' }, '允许她主动开口（只对已绑会话的私聊生效，不在群里搭话）'),
              ]),
              numberField('proactiveIdleHours', '空闲多久', '小时', '距上次说话至少这么久才考虑开口。可填小数，比如 2.5'),
              numberField('proactiveIdleMaxHours', '最多等到', '小时', '填得比上一个大时，门槛在「空闲多久 ~ 最多等到」之间摇号（0 = 不随机）。同一段安静期只摇一次，不会每 60 秒变'),
              numberField('proactiveDailyMax', '每天最多', '次', '每日主动上限，0 = 一次都不主动'),
              numberField('proactiveBackoffMax', '退避上限', '倍', '上次主动对方没回，下次要求的时间翻倍；最多放大到这么多倍（防止每天定时问候）'),
              textField('proactiveQuietFrom', '静默开始', '23:00', '这段时间一次都不主动，写 HH:MM（本地时间）'),
              textField('proactiveQuietTo', '静默结束', '08:00', '跨午夜就写成 23:00 → 08:00'),
            ]),
          ]),
          h('div', { className: 'qqb-card', key: 'whom' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '对谁开口'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, allMode ? '所有已绑私聊' : '只对勾选的人（' + String(picked.length) + ' / ' + String(bound.length) + '）'),
            ]),
            h('div', { className: 'qqb-mode', key: 'mode' }, [
              modeRadio('all', '所有已绑私聊', '谁都可以 —— 以后新绑的人自动进名单'),
              modeRadio('some', '只对勾选的人', '只对下面勾上的人开口；勾掉的人连「该不该说」都不会算'),
            ]),
            h('div', { key: 'rows', style: { padding: '4px 0 0' } }, targetRows),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', {
                className: 'qqb-btn',
                key: 'try',
                disabled: busy,
                onClick: function () { runProactiveNow('') },
              }, '现在试一次'),
              h('span', { className: 'qqb-note', key: 'n' }, nextText(pro)),
            ]),
          ]),
        ])
      }

      /**
       * 「现在试一次」打给谁 —— 必须写出来。
       * 之前这里是「只打名单第一个人」，连点三次全发给同一个人，
       * 另一个号永远轮不到，看着就像「另一个对话没收到」。
       */
      function nextText(pro) {
        var next = pro !== null && pro !== undefined && pro.next ? pro.next : null
        if (next === null) {
          return '现在没有可主动的对象：回到「绑定」给某个人选好会话，再来试。'
        }
        var uin = String(next.uin || '')
        var name = nameOf('private', uin)
        var who = (name === '' ? '' : name + ' ') + '（' + uin + '）'
        return '下一个轮到 ' + who + ' —— 谁最久没被找过就轮到谁，连点会自动换人。'
          + '只想试某一个人，就点他那行的「对TA试一次」。'
      }

      function runProactiveNow(onlyKey) {
        setBusy(true)
        setMsg('')
        apiPost('/proactive-now', onlyKey ? { only: onlyKey } : {})
          .then(function (result) {
            var sent = Number(result && result.sent ? result.sent : 0)
            if (sent > 0) {
              setMsg('已经投出去了 —— 去 QQ 看看她说了什么（可能在几秒后，取决于分条间隔）。')
            } else {
              var skipped = result && Array.isArray(result.skipped) ? result.skipped : []
              var why = skipped.length > 0 ? reasonText(skipped[0].reason) : '没有可主动的对象'
              setMsg('这轮没开口：' + why + '（要先在私聊表格里给某个号绑好会话）')
            }
            reload()
          })
          .catch(function (error) {
            setMsg('触发失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      /** 记忆卡面板：能看见她记住了谁，也能一键清空。 */
      function renderMemory() {
        var t = tunables
        if (t === null) return null
        var mem = data && data.memory ? data.memory : null
        var peers = mem !== null && Array.isArray(mem.peers) ? mem.peers : []
        var count = mem !== null ? Number(mem.count || 0) : 0

        var rows = peers.length === 0
          ? [h('div', { className: 'qqb-empty', key: 'empty' }, '还没记住任何人。等有消息投递过，或者她说「记住你叫什么」之后才会出现。')]
          : peers.slice(0, 6).map(function (item) {
            return h('div', { className: 'qqb-mem-row', key: String(item.key) }, [
              h('span', { className: 'qqb-mem-key', key: 'k' }, String(item.key)),
              h('span', { className: 'qqb-name', key: 'n' }, item.nick === '' ? '（还没起称呼）' : String(item.nick)),
              h('span', { className: 'qqb-hint-inline', key: 'f' }, '记得 ' + String(item.facts) + ' 条 · 说过 ' + String(item.count) + ' 句'),
            ])
          })

        return h('div', { className: 'qqb-card', key: 'memory' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '关系记忆'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, count === 0 ? '空' : '记住了 ' + count + ' 个对象'),
          ]),
          h('div', { className: 'qqb-mem', key: 'b' }, [
            h('label', { className: 'qqb-check', key: 'en', title: '关掉后不再注入「关于他：…」，也不自动记昵称' }, [
              h('input', { type: 'checkbox', key: 'c', checked: t.memoryEnabled === true, onChange: onField('memoryEnabled') }),
              h('span', { key: 'l' }, '把「关于他 / 这个群」带进正文（关掉后回复里不再多出一段记忆）'),
            ]),
          ].concat(rows, [
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', {
                className: 'qqb-btn danger',
                key: 'clear',
                disabled: busy || count === 0,
                onClick: clearMemoryCards,
              }, '清空全部记忆'),
              h('span', { className: 'qqb-note', key: 'n' }, '记忆落在 ~/.dsh/qq-bridge-memory.json，重启不丢；清空不可撤销'),
            ]),
          ])),
        ])
      }

      function clearMemoryCards() {
        var ok = window.confirm('清空她记住的所有人（称呼、喜好、说话次数）？\n\n这个操作不能撤销。')
        if (ok !== true) return
        setBusy(true)
        setMsg('')
        apiPost('/memory-clear', {})
          .then(function (result) {
            setMsg('记忆已清空（' + String((result && result.memory && result.memory.count) || 0) + ' 个对象）')
            reload()
          })
          .catch(function (error) {
            setMsg('清空失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function detectWs() {        setBusy(true)
        setMsg('')
        apiPost('/detect-ws', {})
          .then(function (result) {
            setMsg('已找到 WS 接入点：' + String(result.url || '') + '（来源 ' + String(result.source || '') + '），记得点「保存」')
            reload()
          })
          .catch(function (error) {
            setMsg('自动发现失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      /** 自动发现 HTTP API 接入点（0.15.0）。与 WS 那套 token 不同，别混。 */
      function detectHttp() {
        setBusy(true)
        setMsg('')
        apiPost('/detect-http', {})
          .then(function (result) {
            setMsg('已找到 HTTP 接入点：' + String(result.url || '') +
              (result.hasToken === true ? '（含 token）' : '（该部署未给 HTTP 设 token）') +
              '，来源 ' + String(result.source || '') + '，记得点「保存」')
            reload()
          })
          .catch(function (error) {
            setMsg('自动发现失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function clearCredentials() {
        if (window.confirm('清空 HTTP 与 WebSocket token？\n\n清空后需要重新填写或自动发现。') !== true) return
        setBusy(true)
        setMsg('')
        apiPost('/clear-credentials', {})
          .then(function () {
            setMsg('HTTP / WebSocket token 已清空')
            reload()
          })
          .catch(function (error) {
            setMsg('清空凭据失败：' + errText(error))
          })
          .then(function () { setBusy(false) })
      }

      /**
       * 工具箱 —— 按功能档开关（0.17.4）。
       *
       * 为什么放在「配置」页而不是新开一个分区：分区条已经 7 个，窄窗口里挤成一团。
       * 而且它和 HTTP / WS 一样属于「装好之后很少动」的部署级设置。
       *
       * ⚠️ 字符数**不写死**：由后端 toolSchemaSizes() 实测返回（data.toolSizes）。
       *   工具描述改一句就是几百字符，手写的数字必然过时 —— 那比不写更坏。
       */
      function renderToolbox() {
        var t = tunables
        if (t === null) return null
        var f = t.toolFeatures || {}
        var sizes = (data && data.toolSizes) || null
        // 万位不好读，直接给千位；拿不到实测值就说「实测不可用」，绝不编一个数字
        function chars(key) {
          if (sizes === null || typeof sizes[key] !== 'number') return ''
          return '约 ' + String((sizes[key] / 1000).toFixed(1)) + ' 千字符'
        }
        function row(key, label, detail) {
          var n = chars(key)
          return h('label', { className: 'qqb-check', key: key, title: detail }, [
            h('input', { type: 'checkbox', key: 'c', checked: f[key] === true, onChange: onFeature(key) }),
            h('span', { key: 'l' }, label + (n === '' ? '' : '　·　' + n)),
          ])
        }
        var total = sizes === null ? 0 : (Number(sizes.silence) || 0) + (Number(sizes.emoji) || 0)
          + (Number(sizes.voiceIn) || 0) + (Number(sizes.voiceOut) || 0) + (Number(sizes.poke) || 0)
        return h('div', { className: 'qqb-card', key: 'toolbox' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '工具箱'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '关掉的功能不再进上下文，省 token'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            row('silence', '沉默权', '等 / 划走 / 跳过 / 收尾 —— 决定「什么时候不说话」，是对话手感的一部分'),
            row('emoji', '表情包', '搜表情 / 挑收藏 / 看图 / 改名 —— 一整档，不能拆分'),
            row('voiceIn', '语音识别', '把收到的语音转成文字'),
            row('voiceOut', '发送语音', '让 qq_send 能发一条语音（关掉时连参数一起消失）'),
            row('poke', '戳一戳', '拍一拍某人'),
            h('div', { className: 'qqb-note', key: 'fixed' },
              '「发送消息」（qq_send）始终开启 —— 关掉它这个插件就没意义了，所以不给开关。'),
            h('div', { className: 'qqb-warn', key: 'restart' }, [
              h('span', { key: 'i' }, '⚠'),
              h('span', { key: 't' }, '改完这一块要**重启 DSH** 才生效'
                + '（工具是在插件加载时注册的，不像别的参数下一轮就生效）。'
                + (total > 0 ? '上面这几档全关可省约 ' + String((total / 1000).toFixed(1)) + ' 千字符。' : '')),
            ]),
          ]),
        ])
      }

      function renderWs() {
        var t = tunables
        if (t === null) return null
        return h('div', { className: 'qqb-card', key: 'ws' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, 'HTTP API'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '轮询与发送都走这条；WS 断开时靠它兜底'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            h('label', { className: 'qqb-field', key: 'url' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'HTTP 地址'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'text',
                placeholder: 'http://127.0.0.1:3000/',
                value: t.onebotHttp || '',
                onChange: onField('onebotHttp')
              }),
            ]),
            h('label', { className: 'qqb-field', key: 'tk' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'HTTP token'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'password', autoComplete: 'new-password',
                placeholder: '留空 = 保持原样',
                value: t.token || '',
                onChange: onField('token')
              }),
            ]),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', { className: 'qqb-btn', key: 'd', onClick: detectHttp, disabled: busy }, '自动发现（读 SnowLuma 配置）'),
              h('span', { className: 'qqb-note', key: 'n' }, 'HTTP 的端口/token 在 config/onebot_*.json 的 httpServers 里，跟 WS 那套不是同一个 token，混用会 401'),
            ]),
          ]),
        ])
      }

      function renderPush() {
        var t = tunables
        if (t === null) return null
        return h('div', { className: 'qqb-card', key: 'push' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, 'WebSocket 推送'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '实时收消息；断了自动退回轮询'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            h('label', { className: 'qqb-check', key: 'en' }, [
              h('input', { type: 'checkbox', key: 'c', checked: t.wsEnabled === true, onChange: onField('wsEnabled') }),
              h('span', { key: 'l' }, '启用推送（消息即时到达，延迟从约 1 秒降到接近 0）'),
            ]),
            h('label', { className: 'qqb-field', key: 'url' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'WS 地址'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'text',
                placeholder: 'ws://127.0.0.1:3001/',
                value: t.wsUrl || '',
                onChange: onField('wsUrl')
              }),
            ]),
            h('label', { className: 'qqb-field', key: 'tk' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'WS token'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'password', autoComplete: 'new-password',
                placeholder: '留空 = 保持原样',
                value: t.wsToken || '',
                onChange: onField('wsToken')
              }),
            ]),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', { className: 'qqb-btn', key: 'd', onClick: detectWs, disabled: busy }, '自动发现（读 SnowLuma 配置）'),
              h('span', { className: 'qqb-note', key: 'n' }, 'SnowLuma 的 WS 端口/token 在 config/onebot_*.json 的 wsServers 里，跟 HTTP 那套不是同一个 token'),
            ]),
          ]),
        ])
      }

      /** 「配置」分区：HTTP API + WebSocket + 工具箱（0.15.0 / 0.17.4）。 */
      function renderConfig() {
        return h('div', { className: 'qqb-pane', key: 'config' }, [
          renderWs(),
          renderPush(),
          renderToolbox(),
          h('div', { className: 'qqb-tools', key: 'credentials' }, [
            h('button', { className: 'qqb-btn danger', onClick: clearCredentials, disabled: busy }, '清空 HTTP / WS token'),
            h('span', { className: 'qqb-note' }, '清空后不会自动恢复，需重新填写或自动发现')
          ])
        ])
      }

      /** tab 角标：绑了几个、开着没有、记住几个人 —— 不点进去也知道大概。 */
      function tabBadge(id) {
        if (id === 'binding') {
          var n = Object.keys(draft.private || {}).length + Object.keys(draft.group || {}).length
          return n === 0 ? '' : String(n)
        }
        if (id === 'proactive') {
          return data && data.config && data.config.proactiveEnabled === true ? '开' : '关'
        }
        if (id === 'memory') {
          var c = data && data.memory ? Number(data.memory.count) || 0 : 0
          return c === 0 ? '' : String(c)
        }
        return ''
      }

      /** 概览里的一行「项目 + 说明」。 */
      function line(title, text) {
        return h('div', { className: 'qqb-mem-row', key: 'l-' + title, style: { alignItems: 'baseline' } }, [
          h('span', { className: 'qqb-mem-key', key: 't', style: { flex: '0 0 76px' } }, title),
          h('span', { className: 'qqb-hint-inline', key: 'x' }, text),
        ])
      }

      /**
       * 概览 —— 一进来先看「现在是什么状态」，而不是先看到一堆输入框。
       * 数字读服务端已保存的配置（data.config），不读编辑态：改了还没保存就不该显示成已生效。
       */
      function renderOverview() {
        var cfg = (data && data.config) || {}
        var mem = (data && data.memory) || {}
        var pro = (data && data.proactive) || {}
        var merge = (data && data.merge) || {}
        var ws = data && data.ws ? data.ws : null
        var rt = data && data.runtime ? data.runtime : {}

        var privateKeys = Object.keys(draft.private || {})
        var boundPrivate = privateKeys.filter(function (k) {
          var route = draft.private[k]
          return String(route && route.sessionId ? route.sessionId : '') !== ''
        }).length
        var groupKeys = Object.keys(draft.group || {})

        var poolCount = 0
        if (Array.isArray(merge.pools)) {
          for (var i = 0; i < merge.pools.length; i++) poolCount += Number(merge.pools[i].count) || 0
        }

        var peers = pro !== null && Array.isArray(pro.peers) ? pro.peers : []
        var todayCount = 0
        for (var j = 0; j < peers.length; j++) todayCount += Number(peers[j].countToday) || 0

        var targets = Array.isArray(cfg.proactiveTargets) ? cfg.proactiveTargets : []
        var whom = targets.length === 0 ? '所有已绑私聊' : '指定的 ' + String(targets.length) + ' 人'

        function stat(label, value, hint, to) {
          var clickable = typeof to === 'string' && to !== ''
          return h('div', {
            className: 'qqb-stat' + (clickable && to === tab ? ' on' : ''),
            key: 's-' + label,
            style: clickable ? { cursor: 'pointer' } : undefined,
            onClick: clickable ? function () { setTab(to) } : undefined,
            title: clickable ? '点开这一块' : '',
          }, [
            h('div', { className: 'qqb-stat-n', key: 'n' }, String(value)),
            h('div', { className: 'qqb-stat-l', key: 'l' }, label),
            hint === '' ? null : h('div', { className: 'qqb-hint-inline', key: 'h' }, hint),
          ])
        }

        var quick = ['binding', 'stance', 'proactive', 'memory'].map(function (id) {
          var label = id
          for (var k = 0; k < TABS.length; k++) {
            if (TABS[k][0] === id) label = TABS[k][1]
          }
          return h('button', { className: 'qqb-btn', key: 'q-' + id, onClick: function () { setTab(id) } }, label)
        })

        return h('div', { className: 'qqb-pane', key: 'overview' }, [
          h('div', { className: 'qqb-stats', key: 'stats' }, [
            stat('私聊绑定', boundPrivate + ' / ' + privateKeys.length, '已绑会话 / 总绑定', 'binding'),
            stat('群聊绑定', String(groupKeys.length), groupKeys.length === 0 ? '没绑群' : '被 @ 才回', 'binding'),
            stat('今天主动', todayCount + ' / ' + String(Number(cfg.proactiveDailyMax) || 1),
              cfg.proactiveEnabled === true ? '开着 · ' + whom : '开关关着', 'proactive'),
            stat('记住的人', String(Number(mem.count) || 0), cfg.memoryEnabled === false ? '记忆关着' : '', 'memory'),
            stat('待合并', String(poolCount),
              merge.settings ? '窗口 ' + String(merge.settings.windowMs) + 'ms' : '', 'stance'),
            stat('推送', ws !== null && ws.connected === true ? '已连' : '未连',
              ws !== null && ws.connected === true ? '实时收消息' : '走轮询兜底', 'ws'),
          ]),
          h('div', { className: 'qqb-card', key: 'now' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '现在在跑什么'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, '改参数去上面那排里点'),
            ]),
            h('div', { className: 'qqb-mem', key: 'b' }, [
              line('这版代码', rt.version
                ? 'v' + String(rt.version) + ' · 进程 ' + String(rt.pid) + ' · 起于 ' + fmtWhen(Date.parse(String(rt.bootAt || '')))
                : '读不到版本号（package.json 缺失？）'),
              line('连接', 'HTTP ' + (cfg.onebotHttp ? String(cfg.onebotHttp) : '（未配置）') +
                ' · WS ' + (cfg.wsEnabled === false ? '关着' : (ws !== null && ws.connected === true ? '已连' : '未连'))),
              line('绑定', boundPrivate === 0
                ? '还没绑任何私聊 —— 消息会一律忽略'
                : boundPrivate + ' 个私聊已绑会话；没绑的号发来消息一律忽略'),
              line('回复手感', '合并窗口 ' + String(Number(cfg.mergeWindowMs) || 0) + 'ms + 回复前静默 ' +
                String(Number(cfg.replyQuietMs) || 0) + 'ms（两者叠加；都归零就是来一条回一条）'),
              line('沉默权', cfg.closureEnabled === false ? '收尾判断关着' : '双方都收尾时，她会用 qq_close 结束这一场'),
              line('关系记忆', cfg.memoryEnabled === false ? '关着，回复里不会多出「关于他：…」' : '开着，每回合正文前带一小段「关于他」'),
              line('主动搭话', cfg.proactiveEnabled === true
                ? '开着：空闲 ' + String(cfg.proactiveIdleHours) + ' 小时、每天 ' + String(cfg.proactiveDailyMax) +
                  ' 次、' + String(cfg.proactiveQuietFrom) + '–' + String(cfg.proactiveQuietTo) + ' 静默，对' + whom + '生效'
                : '关着（不会自己发消息）'),
              h('div', { className: 'qqb-tools', key: 'q', style: { marginTop: '6px', borderTop: '0', padding: '6px 0 0' } }, quick),
            ]),
          ]),
        ])
      }

      // 分区内容：一次只渲染一块（所有 card 的 key 各自独立，切换不会互相干扰）
      var pane
      if (tab === 'binding') {
        pane = h('div', { className: 'qqb-pane', key: 'binding' }, [
          // 工作区必须先选对，否则下面的会话列表是空的 —— 所以放最上面
          renderWorkspacePicker(),
          renderTable('private', '私聊', '填 QQ 号，比如 1000000001'),
          renderTable('group', '群聊', '填群号'),
        ])
      } else if (tab === 'stance') {
        pane = h('div', { className: 'qqb-pane', key: 'stance' }, renderStance())
      } else if (tab === 'proactive') {
        pane = renderProactive()
      } else if (tab === 'memory') {
        pane = h('div', { className: 'qqb-pane', key: 'memory' }, renderMemory())
      } else if (tab === 'ws') {
        pane = renderConfig()
      } else if (tab === 'advanced') {
        pane = h('div', { className: 'qqb-pane', key: 'advanced' }, renderAdvanced())
      } else {
        pane = renderOverview()
      }

      return h('div', { className: 'qqb-wrap' }, [
        h('div', { className: 'qqb-head', key: 'head' }, [
          h('div', { key: 'l' }, [
            h('div', { className: 'qqb-title-row', key: 't' }, [
              h('span', { className: 'qqb-title', key: 'ti' }, 'QQ 桥接'),
              selfBadge(data.self),
              wsBadge(data.ws)
            ]),
            h('div', { className: 'qqb-note', key: 'n' }, '每个号绑定一个 DSH 会话。没绑定的消息一律忽略（不会乱投到别的会话）。'),
          ]),
          h('div', { key: 'r', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('button', { className: 'qqb-btn', key: 'r', onClick: reload, disabled: busy }, '重新载入'),
            h('button', { className: 'qqb-btn primary', key: 's', onClick: save, disabled: busy }, busy ? '处理中…' : '保存'),
          ]),
        ]),
        // 总开关只在配置文件里（index.js 加载时读一次），所以这里只报状态、不给按钮 ——
        // 放个可点的开关会让人以为点了就生效，实际得重启 DSH。
        data.config && data.config.enabled === false
          ? h('div', { className: 'qqb-warn', key: 'off' }, [
              h('span', { key: 'i' }, '⚠'),
              h('span', { key: 't' }, '插件已停用：配置文件里的 enabled 是 false，收发和工具都不工作。改回 true 后重启 DSH 才会恢复。'),
            ])
          : null,
        msg === '' ? null : h('div', {
          className: 'qqb-msg ' + (msg.indexOf('失败') >= 0 || msg.indexOf('不对') >= 0 ? 'err' : 'ok'),
          key: 'msg',
        }, msg),
        h('div', { className: 'qqb-tabs', key: 'tabs' }, TABS.map(function (item) {
          var id = item[0]
          var badge = tabBadge(id)
          return h('button', {
            className: 'qqb-tab' + (tab === id ? ' on' : ''),
            key: 'tab-' + id,
            onClick: function () { setTab(id) },
          }, [
            h('span', { key: 'l' }, item[1]),
            badge === '' ? null : h('span', { className: 'qqb-tab-badge', key: 'b' }, badge),
          ])
        })),
        pane,
        // 底部这行是「一眼确认自己在哪个工作区」用的 —— 显示**标题**而不是路径
        // （路径长得像日志，没人会去读）。要完整路径就 hover。
        h('div', { className: 'qqb-note', key: 'cwd', title: wantCwd }, '会话来源工作区：' + currentWorkspaceLabel()),
      ])
    }

    // ---- 插件入口 ---------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        ensureStyles()
        return function () {
          var el = document.getElementById('dsh-onebot-channel-style')
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-onebot-channel: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'qq-bridge',
          order: 47,
          locale: NS,
          label: function () { return 'QQ 桥接' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          var withCtx = { bridgeCtx: ctx }
          for (var key in p) {
            if (Object.prototype.hasOwnProperty.call(p, key)) withCtx[key] = p[key]
          }
          return h(SectionErrorBoundary, null, h(QqBridgeSection, withCtx))
        })
      })
    }

    var NS = 'dsh-onebot-channel'

    module.exports = {
      name: 'qq-bridge',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
