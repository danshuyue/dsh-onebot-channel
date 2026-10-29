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
      ['ws', '推送'],
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
              groupContextCount: Number(c.groupContextCount || 0),
              groupOnlyWhenAt: c.groupOnlyWhenAt === true,
              splitReply: c.splitReply === true,
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
              closureEnabled: c.closureEnabled !== false,
              // 0.8.0：关系记忆与上线补历史
              memoryEnabled: c.memoryEnabled !== false,
              // 0.9.0：私聊合并窗口（标记已读的中间态）
              mergeWindowMs: Number(c.mergeWindowMs || 0),
              mergeMaxWaitMs: Number(c.mergeMaxWaitMs || 15000),
              mergeMaxMessages: Number(c.mergeMaxMessages || 10),
              // 0.9.0：主动搭话
              proactiveEnabled: c.proactiveEnabled === true,
              proactiveIdleHours: Number(c.proactiveIdleHours || 6),
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
              qzoneRequireConfirm: c.qzoneRequireConfirm !== false,
              imageCopyDir: String(c.imageCopyDir || ''),
              textPrefix: String(c.textPrefix || ''),
              wsEnabled: c.wsEnabled !== false,
              wsUrl: String(c.wsUrl || ''),
              wsFallbackPollMs: Number(c.wsFallbackPollMs || 30000),
              // token 不回显：留空 = 保持原样（保存时不会误清掉）
              wsToken: ''
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
          workspaceCwd: data && data.config ? data.config.workspaceCwd : undefined,
        }
        if (tunables !== null) {
          for (var key in tunables) {
            if (!Object.prototype.hasOwnProperty.call(tunables, key)) continue
            // token 留空 = 保持原样（后端不返回 token 明文，别把已有的清了）
            if (key === 'wsToken' && String(tunables[key] || '') === '') continue
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
            setMsg('已保存，下一轮投递生效（推送链路会自己重连，不用重启）。')
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
      var wantCwd = String(data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '')
      var sessions = mergeSessions(
        Array.isArray(data.sessions) ? data.sessions : [],
        clientSessions(bridgeCtx, wantCwd)
      )

      function renderTable(kind, title, idLabel) {
        var rows = Object.keys(draft[kind] || {})
        var head = h('div', { className: 'qqb-card-head', key: 'h' }, [
          h('span', { className: 'qqb-card-title', key: 't' }, title),
          h('span', { className: 'qqb-note', key: 'n' }, sessions.length + ' 个可选会话'),
        ])

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
              h('input', {
                className: 'qqb-input',
                key: 'p',
                type: 'text',
                title: '投递时正文前的前缀，留空 = 用全局默认',
                placeholder: '前缀（可选）',
                value: String(route.prefix || ''),
                onChange: function (event) { setPrefixOf(kind, id, event.target.value) },
              }),
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

        return h('div', { className: 'qqb-card', key: kind }, [head].concat(body, [adder]))
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

        function textField(key, label, placeholder, hint) {
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

        return h('div', { className: 'qqb-card', key: 'advanced' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '高级设置'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '改完点上面的「保存」'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            numberField('groupContextCount', '群聊上下文', '条', '被 @ 时附带前面几条群消息当上下文，0 = 不带'),
            numberField('splitMaxChars', '每段最多', '字', '分条发送时单条最多多少字'),
            numberField('splitMaxParts', '最多几条', '条', '一次回复最多拆几条，超出的合并'),
            numberField('splitMinChars', '碎片阈值', '字', '小于这个字数的碎片并进相邻一条，避免「嗯。」单独成条'),
            numberField('splitDelayMinMs', '间隔最小', 'ms', '分条之间最少等多久'),
            numberField('splitDelayMaxMs', '间隔最大', 'ms', '分条之间最多等多久'),
            numberField('pollMs', '私聊轮询', 'ms', '多久拉一次私聊消息（WS 正常时降为下面的补漏间隔）'),
            numberField('groupPollMs', '群聊轮询', 'ms', '多久拉一次群消息'),
            numberField('wsFallbackPollMs', '推送时补漏', 'ms', 'WS 正常时的低频轮询，防漏事件；WS 断开自动回到「私聊轮询」'),
            textField('textPrefix', '默认正文前缀', '（QQ 私聊）', '私聊投递时正文前那行字；单条路由想换前缀就在上面的表格里填'),
            textField('imageCopyDir', '图片副本目录', '留空 = 工作区\\收到的图片', '收到图片时另存一份人能看的副本；填 off 就不存'),
            boolField('groupOnlyWhenAt', '群里只在 @ 时响应', '关掉后群里每条消息都投递'),
            boolField('splitReply', '按标点自动分条', '长回复按标点切成多条再发。模型自己给了 segments 时以它为准，不看这个'),
            boolField('resumeColdSession', '会话没打开时自动冷启动', '关掉后只有开着的会话才收消息'),
            boolField('qzoneRequireConfirm', '发说说必须带 confirm', '对外发布且撤不回，默认开；关掉等于允许她随手发'),
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

        return h('div', { className: 'qqb-card', key: 'stance' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '对话节奏'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '她什么时候开口、愿意等多久'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            numberField('replyQuietMs', '回复前静默', 'ms', '收到消息后先等够这么久再交给模型，让她看起来在「看手机」而不是秒回。0 = 关。建议试 5000，总预算 60 秒封顶（防刷屏）'),
            numberField('mergeWindowMs', '合并窗口', 'ms', '私聊连发几条时先攒一会儿再一起回（「标记已读」的中间态：先记账，不立刻开回合）。0 = 关，回到来一条回一条。跟「回复前静默」会叠加，两个都开时延迟相加'),
            numberField('mergeMaxWaitMs', '合并上限', 'ms', '最多攒这么久就强制放行 —— 对方一直发也不能无限等'),
            numberField('mergeMaxMessages', '合并条数', '条', '池里攒到这么多条立刻放行，一口气十条已经不算「还没说完」'),
            numberField('waitMaxMs', '等待上限', 'ms', 'qq_wait 一次最多等多久'),
            boolField('closureEnabled', '允许判断收尾', '开着才会在双方都收尾时用 qq_close 结束会话；对方还有问题没答时会硬判继续。卡在收尾上时临时关掉'),
            boolField('autoForwardReply', '自动转发回复', '回合结束后把最终回复自动发回 QQ，不依赖 qq_send'),
            boolField('backfillOnStart', '上线补历史', '掉线期间攒的消息按游标翻回来（每页 50 条），否则超过 10 条会永久丢'),
            numberField('backfillMaxPages', '补历史最多', '页', '每个对象最多往回翻几页'),
            numberField('backfillDeliver', '补历史投递', '条', '超出的只报数不展开，避免灌爆上下文'),
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
       */
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

        function textField(key, label, placeholder, hint) {
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
              h('span', { className: 'qqb-note', key: 'n' }, '跳过所有闸立刻投一次（开关关着也能试）；她说还是不说仍由模型决定，没话说就会 qq_pass'),
            ]),
          ]),
        ])
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

      function renderWs() {
        var t = tunables
        if (t === null) return null
        return h('div', { className: 'qqb-card', key: 'ws' }, [
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
                className: 'qqb-input', key: 'i', type: 'password',
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
        pane = h('div', { className: 'qqb-pane', key: 'ws' }, renderWs())
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
        h('div', { className: 'qqb-note', key: 'cwd' }, '会话来源工作区：' + String(data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '（未设置）')),
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
