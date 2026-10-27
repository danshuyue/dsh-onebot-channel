/**
 * sendapi.js —— AI 主动发消息的本地接口（给会话里的 AI 用，不需要 QQ 那边先开口）。
 *
 *   POST http://127.0.0.1:<sendApiPort>/send
 *   body: { "text": "要说的话", "user_id": "1000000004" }   // 不传 user_id 就发给默认私聊对象
 *   body: { "text": "群里说的话", "group_id": "2000000001" } // 传 group_id 发群
 *   GET  http://127.0.0.1:<sendApiPort>/health             // 看活着没
 *
 * 只绑 127.0.0.1，外面够不着；纯文本，走 sendToQQ（会按配置分条）。
 */
import { createServer } from 'node:http'
import { getConfig } from './config.js'
import { note } from './env.js'
import { sendToQQ } from './outbound.js'

export function startSendApi(stopFns) {
  const port = Number(getConfig().sendApiPort) || 39273
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  let server
  try {
    server = createServer((req, res) => {
      void (async () => {
        const url = (req.url ?? '').split('?')[0]
        try {
          if (req.method === 'GET' && (url === '/' || url === '/health')) {
            const config = getConfig()
            return json(res, 200, { ok: true, enabled: config.enabled, selfUin: String(config.selfUin ?? '') })
          }
          if (req.method === 'POST' && url === '/send') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const text = String(body.text ?? '').trim()
            if (text === '') return json(res, 400, { ok: false, error: 'text 不能为空' })
            const groupId = String(body.group_id ?? body.groupId ?? '').trim()
            const userId = String(body.user_id ?? body.userId ?? '').trim()
            // 群优先，跟 qq_send 一致
            const target = groupId !== ''
              ? { kind: 'group', id: groupId }
              : (userId !== '' ? { kind: 'private', id: userId } : { kind: 'private' })
            const result = await sendToQQ(target, text)
            note('sendapi', `sent ${groupId !== '' ? `group ${groupId}` : `private ${userId || 'default'}`} len=${text.length}`)
            return json(res, 200, { ok: true, message_id: Number(result?.data?.message_id ?? 0) })
          }
          return json(res, 404, { ok: false, error: `unknown route: ${url}` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          note('sendapi', `error ${message}`)
          return json(res, 500, { ok: false, error: message })
        }
      })()
    })
    server.on('error', (error) => {
      // 多实例抢端口是最常见的失败原因，不该连累收发主链路
      note('sendapi', `listen failed ${error instanceof Error ? error.message : error}`)
    })
    server.listen(port, '127.0.0.1', () => {
      note('sendapi', `AI 自动发消息接口已启动 http://127.0.0.1:${port}/send`)
    })
    if (Array.isArray(stopFns)) {
      stopFns.push(() => {
        try { server.close() } catch {}
      })
    }
  } catch (error) {
    note('sendapi', `start failed ${error instanceof Error ? error.message : error}`)
  }
}
