/**
 * dsh-onebot-channel —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册「QQ 桥接」设置页（slot: settings.section）：
 *   - 每个 QQ 好友 / 群 → 绑定一个 DSH 会话；
 *   - 没绑定的号发来的消息一律忽略（不发散、不兜底）；
 *   - 可以在这里给某个号新建会话，标题用好友昵称 / 群名。
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
      '.qqb-row{display:grid;grid-template-columns:132px 1fr 210px auto;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
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
              splitDelayMinMs: Number(c.splitDelayMinMs || 200),
              splitDelayMaxMs: Number(c.splitDelayMaxMs || 700),
              pollMs: Number(c.pollMs || 2000),
              groupPollMs: Number(c.groupPollMs || 3000),
              resumeColdSession: c.resumeColdSession !== false,
              wsEnabled: c.wsEnabled !== false,
              wsUrl: String(c.wsUrl || ''),
              // token 不回显：留空 = 保持原样（保存时不会误清掉）
              wsToken: ''
            })
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
        }
        apiPost('/save', payload)
          .then(function () {
            setMsg('已保存。新配置下一轮轮询生效。')
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

      function nameOf(kind, id) {
        if (!data) return ''
        var pool = kind === 'group' ? data.groups : data.friends
        if (!Array.isArray(pool)) return ''
        for (var i = 0; i < pool.length; i++) {
          if (String(pool[i].id) === String(id)) return String(pool[i].name || '')
        }
        return ''
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

        return h('div', { className: 'qqb-card', key: 'advanced' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '高级设置'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '改完点上面的「保存」'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            numberField('groupContextCount', '群聊上下文', '条', '被 @ 时附带前面几条群消息当上下文，0 = 不带'),
            numberField('splitMaxChars', '每段最多', '字', '分条发送时单条最多多少字'),
            numberField('splitDelayMinMs', '间隔最小', 'ms', '分条之间最少等多久'),
            numberField('splitDelayMaxMs', '间隔最大', 'ms', '分条之间最多等多久'),
            numberField('pollMs', '私聊轮询', 'ms', '多久拉一次私聊消息'),
            numberField('groupPollMs', '群聊轮询', 'ms', '多久拉一次群消息'),
            boolField('groupOnlyWhenAt', '群里只在 @ 时响应', '关掉后群里每条消息都投递'),
            boolField('splitReply', '分条发送', '长回复按标点切成多条再发'),
            boolField('resumeColdSession', '会话没打开时自动冷启动', '关掉后只有开着的会话才收消息'),
          ]),
        ])
      }

      function detectWs() {
        setBusy(true)
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
        msg === '' ? null : h('div', {
          className: 'qqb-msg ' + (msg.indexOf('失败') >= 0 || msg.indexOf('不对') >= 0 ? 'err' : 'ok'),
          key: 'msg',
        }, msg),
        renderTable('private', '私聊', '填 QQ 号，比如 1000000001'),
        renderTable('group', '群聊', '填群号'),
        renderWs(),
        renderAdvanced(),
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
