# Breeze Blue TTS API 调研（2026-11-07）

> 调研方式：逐个抓取 `docs.breezeblue.ai` 下的 `.md` 版页面 + 官方 `openapi.json` 全量规范 + npm registry 元数据。
> 第 1–11 章写于**没有 key 的阶段**，凡文档没写清的，一律标「文档未说明」，不做猜测。
> **第 12 章是真机验证**：拿到 key 之后把第 11 章的关键项逐条实测，结果与文档有出入的以实测为准。
> ⚠️ 第 12 章推翻了第 11 章和正文里的若干推断，**读结论请直接看第 12 章**。

---

## 1. 一句话结论

**可以不装 SDK，用纯 fetch 直接调。** 官方 SDK（`@breeze.blue/sdk`）本身就是一层 `globalThis.fetch` 的薄封装，没有私有协议、没有签名、没有本地依赖。

最小可用请求只需要 **3 个要素**：

| # | 要素 | 位置 | 说明 |
|---|---|---|---|
| 1 | `voice_id` | **URL 路径** | 不是 body 字段，形如 `voc_xeh3w54cqvnp` |
| 2 | `xi-api-key` | 请求头 | 或 `Authorization: Bearer <key>`，二选一 |
| 3 | `{"text": "..."}` | JSON body | `text` 是**唯一必填**的 body 字段 |

⚠️ **最容易踩的坑**：`output_format` 是 **query 参数，不在 body 里**。写进 body 会被 schema 的 `additionalProperties: false` 拒绝（`VALIDATION_ERROR`）。

来源：<https://docs.breezeblue.ai/api-reference/introduction.md>、<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>

---

## 2. 鉴权与端点

### Base URL

```
https://api.breeze.blue/v1
```

所有公开端点都在 `/v1/*` 下，返回 JSON 或二进制音频。

来源：<https://docs.breezeblue.ai/api-reference/introduction.md>

### 两种鉴权头（等价，可互换）

```http
xi-api-key: brz_xxxxxxxxxxxxxxxx
```

```http
Authorization: Bearer brz_xxxxxxxxxxxxxxxx
```

**两者同时存在时，`xi-api-key` 优先。**

来源：<https://docs.breezeblue.ai/authentication.md>

### 例外：账户管理端点

`/v1/api-keys` 系列（列/建/删/改/禁用/启用/轮换密钥）**要求浏览器会话，不接受 API key**。
唯一的例外是 `GET /v1/api-keys/current`——它接受 API key，用于查当前 key 的预算状态。

来源：<https://docs.breezeblue.ai/authentication.md>、<https://docs.breezeblue.ai/api-reference/introduction.md>

### 内容类型

| 场景 | Content-Type |
|---|---|
| JSON 请求 | `application/json` |
| 声音克隆（上传音频） | `multipart/form-data` |
| 音频响应 | 原始二进制（raw binary） |
| 时间戳端点响应 | `application/json`（音频在 `audio_base64` 里） |

来源：<https://docs.breezeblue.ai/api-reference/introduction.md>

### 最小可用 curl

```bash
curl -X POST "https://api.breeze.blue/v1/text-to-speech/voc_xeh3w54cqvnp?output_format=mp3" \
  -H "xi-api-key: $BREEZE_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "text": "你好，世界。" }' \
  --output out.mp3
```

来源：<https://docs.breezeblue.ai/guides/text-to-speech.md>

---

## 3. 同步合成的最小请求

### 端点

```
POST /v1/text-to-speech/{voice_id}
```

来源：`openapi.json` operationId `tts_generate`，<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>

### 完整 curl（带全部常用字段）

```bash
curl \
  --request POST \
  --url "https://api.breeze.blue/v1/text-to-speech/voc_xeh3w54cqvnp?output_format=mp3&delivery=sync" \
  --header "xi-api-key: $BREEZE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "text": "I can not believe you brought him here!",
    "model_id": "breeze-tts-2",
    "language_code": "en",
    "instructions": "Say it softly and emotionally, with a hurt, disappointed tone.",
    "voice_settings": {
      "guidance_scale": 4.0,
      "speed": 1.0,
      "volume": 1.0,
      "use_speaker_boost": false
    }
  }' \
  --output out.mp3
```

来源：<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>（官方 cURL 示例，本表按 OpenAPI 补全了其余字段）

### 响应形态

**200 —— 二进制音频，不是 JSON。**

- Body：原始音频字节，`Content-Type` 随 `output_format` 变化（`audio/mpeg` / `audio/wav` / `audio/flac` / `audio/aac` / `audio/opus` / `audio/pcm`）
- 响应头 `history-item-id`：本次生成的 history 记录 ID
- 响应头 `x-breeze-api-key-id`：本次鉴权用的公开 key 标识

**202 —— 异步任务（仅当 `delivery=async`）**

```json
{
  "generation_job_id": "gjb_...",
  "history_item_id": "his_...",
  "status": "..."
}
```

之后用 `GET /v1/generation-jobs/{generation_job_id}` 轮询，用 `GET /v1/generation-jobs/{generation_job_id}/audio` 下载。

来源：<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>

### 长度上限

| 项 | 值 | 来源 |
|---|---|---|
| 单请求文本默认上限 | **1,000 字符** | OpenAPI `TtsRequest.text` description |
| 申请提额后的上限 | 最多 **2,000 字符** | 同上 |
| 超长处理方式 | **直接拒绝，不截断** | <https://docs.breezeblue.ai/guides/text-to-speech.md> |
| 中文特殊分段 | 显式 `language_code: "zh"` 且非流式时，超过 500 字符会被切成最多 5 段（每段 ≤500，优先按标点/空白切分） | <https://docs.breezeblue.ai/guides/text-to-speech.md> |
| 分段段间静音 | 段与段之间**恰好加 0.25 秒静音**，结尾不加 | 同上 |
| 分段计费 | 按**原文一次**计费，不按分段重复计费 | 同上 |

来源：<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>、<https://docs.breezeblue.ai/guides/text-to-speech.md>

### 超时

**文档未说明**服务端的同步请求超时上限。
（参考值：官方 SDK 的客户端默认 timeout 是 `60_000` ms，见 `dist/client.js` 的 `DEFAULT_TIMEOUT_MS = 60_000`，但这是客户端行为，不代表服务端上限。）

来源：<https://unpkg.com/@breeze.blue/sdk@0.23.0/dist/client.js>

---

## 4. 参数全表

### 4.1 路径 / Query 参数

| 字段 | 类型 | 取值 | 默认 | 说明 | 来源 |
|---|---|---|---|---|---|
| `voice_id` | string | 任意可用音色 ID，形如 `voc_xxx` | — | **路径参数，必填** | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) |
| `output_format` | string \| null | `mp3` `wav` `flac` `pcm` `aac` `opus` `mp3_24000_64` `mp3_24000_96` `mp3_24000_128` `mp3_24000_160` `wav_24000` `pcm_24000` `flac_24000` `aac_24000_128` | `mp3` | **query 参数**。profile 形式为 `codec_采样率_码率` | 同上 + [output-format](https://docs.breezeblue.ai/concepts/output-format.md) |
| `delivery` | string | `sync` \| `async`（正则 `^(sync\|async)$`） | `sync` | `async` 返回 202 + 后台任务 | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) |

### 4.2 Body 字段（`TtsRequest`，`additionalProperties: false`）

| 字段 | 类型 | 取值 | 默认 | 说明 | 来源 |
|---|---|---|---|---|---|
| `text` | string | `minLength: 1`；默认 ≤1000 字符，提额后 ≤2000 | — | **唯一必填字段**。超长直接拒绝不截断 | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) |
| `model_id` | string \| null | `minLength: 1`, `maxLength: 120` | 省略时自动选择 | 省略时：显式 `language_code` 为 `en`/`zh` → 选 `breeze-tts-2`；其他语言或省略 → 选 `breeze-tts-2-multilingual` | 同上 + [text-to-speech guide](https://docs.breezeblue.ai/guides/text-to-speech.md) |
| `language_code` | string \| null | 2 字母 ISO 639-1，正则 `^[A-Za-z]{2}$` | 省略（字段不落库） | 必须被所选模型支持。省略时模型自行处理文本，**不会继承参考音色的语言** | 同上 + [multilingual](https://docs.breezeblue.ai/concepts/multilingual.md) |
| `instructions` | string \| null | 任意字符串，**上限 1,000 字符** | 省略 | 表演指令，**必须与输入文本/`language_code` 同语言**，不做自动翻译。前后空白会被去掉 | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) + [voice-instruction-prompting](https://docs.breezeblue.ai/guides/voice-instruction-prompting.md) |
| `voice_settings` | object \| null | 见下表 | 省略 | 每次请求独立生效，不持久化 | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) |

### 4.3 `voice_settings` 子字段（`TtsVoiceSettingsPayload`，`additionalProperties: false`）

| 字段 | 类型 | 取值 | 默认 | 说明 | 来源 |
|---|---|---|---|---|---|
| `guidance_scale` | number \| null | `1.0` – `10.0` | `1.0` | 生成对 `instructions` 和参考音色的贴合强度。越高越贴合 | [convert-text-to-speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md) |
| `speed` | number | `0.5` – `2.0` | `1.0` | 变速**保持音高不变**。0.5 约时长翻倍，2.0 约减半，停顿一起缩放。**实时 WebSocket 不支持** | 同上 + [text-to-speech guide](https://docs.breezeblue.ai/guides/text-to-speech.md) |
| `volume` | number | `0.01` – `2.0`（1%–200%） | `1.0` | 线性振幅乘数，**不是响度归一化**。>1.0 可能削波 | 同上 |
| `use_speaker_boost` | boolean | `true` / `false` | `false` | 提升对参考音色的相似度。**当 `instructions` 非空且 `guidance_scale > 1` 时被忽略**；否则为 true 时 `guidance_scale` 按 1 处理。`instructions` 总是生效 | 同上 |

来源：<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>

### 4.4 `guidance_scale` 的实用建议（官方给的起点，非默认值）

- 表现力强的段落：从 **1–3** 试起
- 连续旁白：从 **1** 起，在 **1–2** 之间试听
- 硬性接受范围：**1–10**

来源：<https://docs.breezeblue.ai/guides/voice-instruction-prompting.md>

### 4.5 `instructions` 怎么写

用自然语言描述五个维度中的两三个即可（不必全用）：

1. **Situation** 处境：影响表演的场景，例如"怕被人听见"
2. **Intent** 意图：想达到什么——安抚、劝阻、警告、掩饰
3. **Emotion and intensity** 情绪与强度：如"克制的恐慌"、"轻微不耐烦"
4. **Rhythm and emphasis** 节奏与重音：语速、停顿、气息、强调词
5. **Physical and vocal state** 生理/声带状态："跑得上气不接下气"、"忍泪，声音发哑"

约束：
- 必须用**与文本相同的语言**写
- 上限 1,000 字符
- 不要写相互矛盾的指令、不要写精确时间点承诺
- 音色身份（年龄/口音/音质）应通过**选音色或 Voice Design** 确定，不要塞进 `instructions`

来源：<https://docs.breezeblue.ai/guides/voice-instruction-prompting.md>

---

## 5. 音色

### voice_id 从哪来

| 来源 | 端点 / 界面 | 说明 |
|---|---|---|
| 公开目录 | `GET /v1/voices` | Breeze 随附的策展音色 |
| 网页浏览 | `https://breezeblue.ai/app/voice-library` | 可视化浏览、试听、复制 voice ID |
| 设计生成 | `POST /v1/voice-previews/design` → `POST /v1/voice-previews/{generated_voice_id}/save` | 从文字描述生成 |
| 克隆 | `POST /v1/voice-previews/clone` → `.../save` | 从音频样本克隆 |
| 本地化 | `POST /v1/voice-previews/localize` → `.../save` | 从已有音色生成另一语言的版本 |

`voice_type="default"` 是官方目录，`voice_type="personal"` 是用户自存音色。类别是 `premade` / `generated` / `cloned`。

来源：<https://docs.breezeblue.ai/concepts/voices.md>

### 怎么列 / 怎么搜

```
GET /v1/voices
```

常用 query 参数：

| 参数 | 说明 |
|---|---|
| `search` | 公开目录按**语义 + 文本**相关性搜；个人音色按名称/描述/ID 搜。精确名称匹配排最前 |
| `language_code` | 51 个 ISO 639-1 码之一，只返回该语言音色。**在语义排序之前过滤** |
| `accent` | 口音码过滤。`american` 也会匹配 accent 为 null 的英文音色 |
| `accent_mode` | `all`（默认）/ `unmarked`。`unmarked` 只返回 accent 为 null 的音色，**不能与 `accent` 同时用** |
| `gender` | 可重复，`male` / `female` / `neutral`，OR 语义 |
| `age` | 可重复，`child` / `young` / `middle_aged` / `old` |
| `tone` | 可重复，20 种 tone 码，匹配任一即可 |
| `primary_category_code` | 12 个类别码之一（`narration` / `social-media` / `ads-brand` / `podcast` / `learning` / `support-agents` / `roleplay` / `gaming` / `animation` / `cinematic` / `wellness` / `stylized`） |
| `voice_type` | `all`（默认）/ `default` / `personal` |
| `origin` | `designed` / `cloned` |
| `sort` | `created_at_unix`（默认）/ `name` / `trend`（`trend` 仅配 `voice_type=default`） |
| `sort_direction` | `asc` / `desc`（默认 desc） |
| `tags` | 可重复，全值大小写不敏感 AND 匹配 |
| `favorites_only` | `true` 只返回在 Studio 收藏过的 |

来源：<https://docs.breezeblue.ai/api-reference/voices/list-voices.md>

### 分页

两种方式并存：

- **页码**：`page`（≥1，默认 1）+ `page_size`（1–100，默认 50）
- **游标**：`next_page_token`（从上一响应里取，需保持同样的筛选条件）

响应顶层字段：`voices[]`、`has_more`、`next_page_token`、`total`、`page`、`page_size`。

浏览 trend 榜时官方建议**跟 `next_page_token` 而不是改 `page`**，因为 token 会把每日快照钉住（有效期约 2 小时），避免午夜刷新导致翻页顺序错乱。

来源：<https://docs.breezeblue.ai/api-reference/voices/list-voices.md>、<https://docs.breezeblue.ai/concepts/voices.md>

### 中文音色存在吗

**存在。** `zh` 在 51 个语言码内。中文有 8 个非空方言口音码：

| 口音 | `accent` 值 |
|---|---|
| 普通话 | `null` |
| 东北官话 | `mandarin_northeastern` |
| 陕西官话 | `mandarin_shaanxi` |
| 上海官话 | `mandarin_shanghai` |
| 四川官话 | `mandarin_sichuan` |
| 河南官话 | `mandarin_henan` |
| 北京官话 | `mandarin_beijing` |
| 台湾国语 | `mandarin_taiwan` |
| 粤语 | `cantonese` |

**找普通话音色的正确写法**：`GET /v1/voices?language_code=zh&accent_mode=unmarked`
（`accent=null` 即普通话；`accent_mode=unmarked` 与 `accent` 参数互斥）

⚠️ `accent` 是**音色元数据**，不是 TTS 请求参数——合成的口音由你选的 `voice_id` 决定，请求里没有 `accent` 字段。

来源：<https://docs.breezeblue.ai/concepts/multilingual.md>、<https://docs.breezeblue.ai/concepts/voices.md>

### 能不能自建 / 克隆

**能，两条路都行。** 都是「两步流程」：先出 preview，再 save 成正式音色。

**克隆（`POST /v1/voice-previews/clone`，`multipart/form-data`）**

| 限制 | 值 |
|---|---|
| 文件数 | **恰好 1 个** |
| 格式 | MP3 / WAV / M4A / FLAC / AAC / OGG / Opus / WebM / WMA / AIFF |
| 最短时长 | **3 秒** |
| 最长时长 | **无上限**（无最大时长限制） |
| 最大文件体积 | **5 MB** |
| 处理方式 | **同步**（不是后台任务） |
| 参考音频裁剪 | 只分析**前 60 秒**，截取并保留**最多 30 秒**，落在最后一个完整句末；归一化到 **-18 LUFS** |
| 中文提示 | 中文参考音频传 `reference_language_code=zh`；中文 ASR 失败会返回可重试错误，**不会回退到自动识别** |
| 降噪 | `remove_background_noise=true`，默认 `false`；降噪不可用时用原音频 |

⚠️ 克隆返回的是 `generated_voice_id`（形如 `gvi_xxx`），**不是** `voice_id`。要调 `POST /v1/voice-previews/{generated_voice_id}/save` 存成正式音色后才能用于 TTS。`save` 时 `language_code` **必填**，且会占用一个音色名额。

**设计（`POST /v1/voice-previews/design`）**：从文字描述生成，无需音频。
**本地化（`POST /v1/voice-previews/localize`）**：把已有音色变成本说另一种语言的音色，源音色不变，是**后台任务**需轮询。

来源：<https://docs.breezeblue.ai/guides/voice-clone.md>、<https://docs.breezeblue.ai/concepts/voices.md>、<https://docs.breezeblue.ai/api-reference/voices/list-voices.md>

### 缓存建议

官方明确建议：**voice-list 响应在客户端至少缓存 60 秒**，只在用户主动操作或增删改音色后刷新，**不要在应用空闲时持续轮询目录**。

来源：<https://docs.breezeblue.ai/concepts/voices.md>

---

## 6. 输出格式

BreezeBlue 原生生成 **24 kHz 单声道**音频。

### 按端点划分的可用格式

| 端点 | 可用格式 | 默认 |
|---|---|---|
| 同步 / 异步合成（含带时间戳） | `mp3` `wav` `flac` `pcm` `aac` `opus` + 全部 profile | `mp3` |
| HTTP 流式（含带时间戳流） | `pcm` `mp3` `wav`（**仅裸编码名**） | `pcm` |
| 实时 WebSocket | `pcm` `mp3` | `pcm` |

### 编码对照表

| format 名 | 编码 | 采样率 | 能否同步返回 | 备注 |
|---|---|---|---|---|
| `mp3` | MP3 | 24 kHz | ✅ | 默认 **128 kbps** |
| `wav` | 未压缩 signed 16-bit PCM + WAV 容器 | 24 kHz | ✅ | 单声道 |
| `pcm` | 无头 signed 16-bit **小端** PCM | 24 kHz | ✅ | 解码器需自行按 24 kHz 单声道配置 |
| `flac` | 无损 FLAC | 24 kHz | ✅ | — |
| `aac` | AAC in ADTS | 24 kHz | ✅ | 目标 **128 kbps**，实测均值随音频变化 |
| `opus` | Opus in Ogg | 24 kHz | ✅ | 目标 **96 kbps** |
| `mp3_24000_64` | MP3 | 24 kHz | ✅ | 64 kbps |
| `mp3_24000_96` | MP3 | 24 kHz | ✅ | 96 kbps |
| `mp3_24000_128` | MP3 | 24 kHz | ✅ | 128 kbps |
| `mp3_24000_160` | MP3 | 24 kHz | ✅ | 160 kbps |
| `wav_24000` | WAV | 24 kHz | ✅ | 16-bit 单声道 |
| `pcm_24000` | Raw PCM | 24 kHz | ✅ | 16-bit 单声道 |
| `flac_24000` | FLAC | 24 kHz | ✅ | — |
| `aac_24000_128` | AAC | 24 kHz | ✅ | 目标 128 kbps |

**要点**：

- profile 命名规则是 `codec_采样率_码率`，WAV / PCM / FLAC 省略码率部分
- **profile 只适用于同步 / 异步**；流式和实时只接受裸编码名（`pcm` / `mp3` / `wav`）
- 非法格式返回 `BAD_REQUEST`
- 码率对 MP3 / AAC / Opus 有效
- 实时端点里每个 turn 独立编码，最终音频字节在 `turn.done` 之前全部送达

来源：<https://docs.breezeblue.ai/concepts/output-format.md>、<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>

---

## 7. 计费与限流

### 计费单位

**10 billable units = 1 credit。**

| 字符类型 | 计费单位 |
|---|---|
| CJK 字符（汉字、假名、谚文） | **2 units / 字** |
| 其他所有字符（拉丁字母、数字、空格、标点含中日韩标点、emoji） | **1 unit / 字** |

换算下来：**1 credit = 10 个普通字符 = 5 个汉字**。

官方示例：`你好世界hello` 共 9 字符（4 个 CJK），计 `4×2 + 5×1 = 13` units = **1.3 credits**。
计费记录里 `text_characters` = 9（原始字符数），`billable_units` = 13（计费单位数）。

来源：<https://docs.breezeblue.ai/concepts/pricing.md>

### 单价

| 项 | 价格 | 来源 |
|---|---|---|
| 标准费率 | **$30 / 1M characters**（所有档位一致） | <https://breezeblue.ai/pricing> |
| 年付折算 | 约 **$25 / 1M characters**（付 10 个月用 12 个月） | 同上 |
| 充值 | **10,000 credits = $3**，最低 $5 起 | 同上 + [pricing](https://docs.breezeblue.ai/concepts/pricing.md) |
| 充值示例 | $5 → 16,667 credits；$9 → 30,000 credits（向上取整到整数） | <https://docs.breezeblue.ai/concepts/pricing.md> |
| 充值有效期 | 购买后 1 年过期 | <https://breezeblue.ai/pricing> |

### 各档位（月付）

| 档位 | 月费 | 每月 credits | 音色位 | 并发档 | 商用 |
|---|---|---|---|---|---|
| Free | $0 | 每天可领 400 免费 credits | 5 | 标准队列 | ❌ **不含** |
| Starter | $9 | 30,000 | 20 | Low | ✅ |
| Creator | $19 | 63,333 | 50 | Medium | ✅ |
| Pro | $99 | 330,000 | 300 | High | ✅ |
| Scale | $299 | 996,667 | 1,000 | Higher | ✅ |
| Business | $999 | 3,330,000 | 3,400 | Highest | ✅ |
| Enterprise | 定制 | 定制 | 定制 | 自定义 | ✅ |

补充：未用的订阅 credits 可结转，上限为一个月的额度（余额最多达月度额度的 2 倍）。**每日 400 免费 credits 需手动领取**，Enterprise 不提供。

来源：<https://breezeblue.ai/pricing>

### 免费额度

- **Free 档：每天可领 400 credits**（手动领取，与订阅 credits 分开）
- Free 档**不含商用授权**

来源：<https://breezeblue.ai/pricing>

### 并发限制

- 限制维度是**并发生成数**（admitted 或正在合成的任务），**不是 RPM**
- 官方原文：*"Standard API requests are not currently throttled by a published request-per-minute quota."*
- **Studio 与 Developer API 共享同一个每用户池**
- 计入并发的操作：同步 TTS、流式 TTS、异步 TTS、Voice Design、Remix、Localization、Voice Cloning
- **具体数值文档未给出**——各档只写了 low/medium/high 这类定性描述，真实数值要从 `GET /v1/entitlements` 的 `max_concurrent_generations` 读

| 档位 | 并发档（官方定性） |
|---|---|
| Free | 标准队列 |
| Starter | Low |
| Creator | Medium |
| Pro | High |
| Scale | Higher |
| Business | Highest |

实时 WebSocket 另有独立限制（详见第 8 节末）：

- 物理连接尝试：**账户级 30 次/分钟，突发 10 个**
- 单会话最长 **30 分钟**；空闲超时默认 **30 秒**，可配到 **180 秒**
- `client_secret` 创建后 **60 秒**过期（只在连接时校验）

来源：<https://docs.breezeblue.ai/reference/rate-limits.md>、<https://docs.breezeblue.ai/concepts/pricing.md>

### 余额查询端点

**`GET /v1/balance`**（`xi-api-key` 鉴权）

响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `balance` | number（必填） | 当前 credits 余额 |
| `balance_millicredits` | integer \| null | 毫 credits 精度余额，默认 null |
| `settlement_pending` | boolean（默认 false） | 是否有尚未入账的扣费 |
| `settlement_interval_seconds` | integer（默认 60） | 批量结算间隔 |
| `topups[]` | array | 最近的充值记录（`topup_id` / `amount` / `status` / `created_at`） |

⚠️ **结算延迟**：配置了批量 TTS 结算的账户，音频生成完成后才记账，结算每 **60 秒**跑一次。`settlement_pending=true` 时，**待结算的扣费还没反映到数字余额里**。另外准入快照每 **5 秒**刷新一次（充值后最多 5 秒恢复可用）。

来源：<https://docs.breezeblue.ai/api-reference/account/get-account-balance.md>、<https://docs.breezeblue.ai/concepts/pricing.md>

**`GET /v1/entitlements`**（`xi-api-key` 鉴权）

响应字段：`plan_code`、`status`、`billing_interval`、`cancel_at_period_end`、`current_period_start`、`current_period_end`、`monthly_creative_credits`、`saved_voice_limit`、`saved_project_limit`、**`max_concurrent_generations`**、`studio_long_form_access`、`commercial_use_allowed`。

其中 `max_concurrent_generations` 是**当前账户的生效并发上限**（已含审批过的自定义上限与临时付费周期额度）——这是唯一能拿到具体并发数字的地方。

来源：<https://docs.breezeblue.ai/api-reference/account/get-account-entitlements.md>

**`GET /v1/api-keys/current`**：查当前 key 的预算计数（`credit_limit` / `credit_used` / `credit_reserved` / `credit_remaining`）。**只读，从不预留 credits**；预算耗尽时仍返回 200，`credit_remaining` 为 0。

来源：<https://docs.breezeblue.ai/authentication.md>

---

## 8. 错误与重试

### 错误信封

```json
{
  "ok": false,
  "code": "AUTH_REQUIRED",
  "detail": "Authentication required.",
  "error": "Authentication required."
}
```

- `ok` 恒为 `false`
- `code`：机器可读错误码
- `detail`：人类可读消息
- `error`：镜像 `detail`
- `meta`：可选，校验错误时可能出现

来源：<https://docs.breezeblue.ai/reference/errors.md>

### 错误码表

| Code | HTTP | 域 | 可重试 | 官方默认消息 |
|---|---|:-:|:-:|---|
| `BAD_REQUEST` | 400 | common | ❌ | The request is invalid. |
| `AUTH_INVALID_SESSION` | 401 | auth | ❌ | Invalid session. |
| `AUTH_REQUIRED` | 401 | auth | ❌ | Authentication required. |
| `AUTH_SESSION_EXPIRED` | 401 | auth | ❌ | Session expired. |
| `AUTH_USER_UNAVAILABLE` | 401 | auth | ❌ | User not available. |
| `BILLING_INSUFFICIENT_CREDITS` | 402 | billing | ❌ | Insufficient credits. |
| `API_KEY_CREDIT_LIMIT_EXCEEDED` | 402 | billing | ❌ | API key credit limit exceeded. |
| `AUTH_ADMIN_ACCESS_DENIED` | 403 | auth | ❌ | Admin console access denied. |
| `AUTH_ADMIN_ROLE_REQUIRED` | 403 | auth | ❌ | Admin role required. |
| `FORBIDDEN` | 403 | common | ❌ | Forbidden. |
| `RESOURCE_NOT_FOUND` | 404 | common | ❌ | Resource not found. |
| `IDLE_TIMEOUT` | 408 | realtime | ✅ | Realtime session timed out while idle. |
| `SESSION_EXPIRED` | 408 | realtime | ✅ | Realtime session reached its maximum duration. |
| `CONFLICT` | 409 | common | ❌ | The request conflicts with current state. |
| `STUDIO_AUDIO_EXPORT_BLOCKED` | 409 | studio | ❌ | Studio audio export is blocked by missing or stale clips. |
| `STUDIO_AUDIO_EXPORT_INCOMPATIBLE_AUDIO` | 422 | studio | ❌ | Studio audio export requires compatible PCM WAV clip audio. |
| `STUDIO_AUDIO_EXPORT_NO_AUDIO` | 422 | studio | ❌ | Studio audio export has no clip audio to export. |
| `STUDIO_AUDIO_EXPORT_UNSUPPORTED_SOURCE` | 422 | studio | ❌ | Studio audio export requires supported clip audio sources. |
| `VALIDATION_ERROR` | 422 | common | ❌ | Request validation failed. |
| `VOICE_CLONE_NO_SPEECH_DETECTED` | 422 | voice | ❌ | No clear speech was detected in the reference audio. |
| `VOICE_CLONE_REFERENCE_LANGUAGE_MISMATCH` | 422 | voice | ❌ | The requested language does not match the language detected in the reference audio. |
| `VOICE_CLONE_REFERENCE_LANGUAGE_UNSUPPORTED` | 422 | voice | ❌ | The language spoken in the reference audio is not supported for voice cloning. |
| `VOICE_CLONE_REFERENCE_TOO_QUIET` | 422 | voice | ❌ | The reference audio is too quiet to detect speech. |
| `GENERATION_NOT_READY` | 425 | generation | ✅ | Generation is not ready yet. |
| `GENERATION_CONCURRENCY_EXCEEDED` | 429 | generation | ✅ | Your plan's concurrent generation limit was reached. Please retry shortly. |
| `RATE_LIMITED` | 429 | common | ✅ | Rate limit exceeded. |
| `INTERNAL_ERROR` | 500 | common | ✅ | Internal server error. |
| `STUDIO_AUDIO_EXPORT_FAILED` | 500 | studio | ✅ | Studio audio export failed. |
| `GENERATION_FAILED` | 502 | generation | ✅ | Generation failed. |
| `GENERATION_INVALID_RESPONSE` | 502 | generation | ✅ | Generation service returned an invalid response. |
| `UPSTREAM_ANALYTICS_ERROR` | 502 | upstream | ✅ | Analytics service request failed. |
| `UPSTREAM_BILLING_ERROR` | 502 | upstream | ✅ | Billing service request failed. |
| `UPSTREAM_GENERATION_ERROR` | 502 | upstream | ✅ | Generation service request failed. |
| `UPSTREAM_GENERATION_SERVICE_ERROR` | 502 | upstream | ❌ | Generation service request failed. |
| `VOICE_CLONE_FAILED` | 502 | voice | ✅ | Voice clone failed. |
| `VOICE_DESIGN_FAILED` | 502 | voice | ✅ | Voice design failed. |
| `VOICE_LOCALIZE_FAILED` | 502 | voice | ✅ | Voice localization failed. |
| `AUTH_CONFIG_MISSING` | 503 | auth | ❌ | Authentication is not configured correctly. |
| `DISPATCH_TIMEOUT` | 503 | generation | ✅ | Generation dispatch timed out before execution. Please try again. |
| `GENERATION_CAPACITY_EXCEEDED` | 429（或 503） | generation | ⚠️ 表标 No | Generation capacity is currently exhausted. Please try again shortly. |
| `GENERATION_INTERRUPTED` | 503 | generation | ✅ | Generation was interrupted by a service restart. Please try again. |
| `LLM_CONFIG_NOT_FOUND` | 503 | upstream | ❌ | LLM feature is not configured. |
| `STUDIO_AUDIO_EXPORT_ASSET_READ_FAILED` | 503 | studio | ✅ | Studio audio export could not read clip audio from storage. |
| `STUDIO_AUDIO_EXPORT_ASSET_WRITE_FAILED` | 503 | studio | ✅ | Studio audio export could not write the result to storage. |
| `STUDIO_AUDIO_EXPORT_STORAGE_UNCONFIGURED` | 503 | studio | ❌ | Studio audio export storage is not configured. |
| `UPSTREAM_ASSET_STORAGE_ERROR` | 503 | upstream | ✅ | Audio asset storage failed. |
| `GENERATION_TIMEOUT` | 504 | generation | ✅ | Generation timed out. Please try again. |
| `UPSTREAM_TIMEOUT` | 504 | upstream | ✅ | Upstream request timed out. |

⚠️ 注意 `GENERATION_CAPACITY_EXCEEDED` 这一行文档**自相矛盾**：表里 HTTP 列写 **429**、Retry 列写 **No**，但同一页的「Capacity refusals」段落写 *"Inference capacity refusals return HTTP 429 with GENERATION_CAPACITY_EXCEEDED"*，且速率限制页建议对 5xx 做退避重试。实际应对：**按 `Retry-After` 退避重试是安全的**，但不要无限重试。

来源：<https://docs.breezeblue.ai/reference/errors.md>

### 哪些该重试

**该重试**（带指数退避 + 抖动）：
- `429 GENERATION_CONCURRENCY_EXCEEDED`、`429 RATE_LIMITED`
- `425 GENERATION_NOT_READY`
- `500 INTERNAL_ERROR`、`502 UPSTREAM_*`、`503 DISPATCH_TIMEOUT`、`503 GENERATION_INTERRUPTED`、`504 GENERATION_TIMEOUT`、`504 UPSTREAM_TIMEOUT`
- 任意**瞬时 5xx**

**不该重试**：
- 全部 `4xx` 鉴权 / 校验 / 计费类（`401` / `403` / `404` / `422` / `402`）
- `402 API_KEY_CREDIT_LIMIT_EXCEEDED` —— 不提高或重置额度就不要重试
- `403 FORBIDDEN` —— key 有效但无权访问该资源

### 429 处理

- 响应头 **`Retry-After`**：整数秒，范围 **0–3600**
- 也可能在 body 的 `meta.retry_after_seconds` 里
- 官方要求：**至少等这么多秒**，并且**加抖动**避免同步爆发
- 重要限定：`Retry-After` **只告诉你可以什么时候重试，不保证下一次一定被接纳**

### 其他重试纪律

- **生成请求不会被自动重放**。传输层超时**不能证明**生成没开始——盲目重发可能重复扣费
- 异步请求被接收后（拿到 202），应**轮询已有 job**，不要重新提交
- 相同输入会被**重复计费**（"Identical inputs are re-billed"）
- 带 `history-item-id` 响应头的 503/504：说明同步任务已创建，可从 history 取回结果，**该结果只计费一次**
- 流式端点在**音频开始之前**可以返回 429；一旦 HTTP 响应已开始，失败会直接终止流，需丢弃不完整输出

来源：<https://docs.breezeblue.ai/reference/errors.md>、<https://docs.breezeblue.ai/reference/rate-limits.md>

---

## 9. 与「本机 GPT-SoVITS」的差异对照

| 维度 | GPT-SoVITS 本机 | Breeze |
|---|---|---|
| **延迟** | 无网络往返，走 `127.0.0.1:9872` 本地推理；耗时随文本长度、`sample_steps` 变化。**未做等条件实测对比** | 需公网往返。同步端点一次性返回整段音频；流式端点（`/stream`）和实时 WebSocket 才能降 TTFA。文档未给 SLA 数字，只有 `audio.started.ttfa_ms` 这类自测量字段 |
| **成本** | **零**（电费/本机算力） | `$30 / 1M characters`；1 credit = 10 普通字符 = 5 汉字；充值 $3 / 10k credits，$5 起 |
| **音色可控性** | 极高。**1275 个参考音频**按场景分 10 个目录（anecdote / freetalk / gameplay / battle_skill / chest_open / weather / WQ / AQ 等），每条附同名 `.txt` 台词；可自己训练微调模型并热切换 | 中高。可选公开目录音色、文字描述生成（design）、音频克隆（≥3 秒、≤5 MB、只取前 60 秒内最多 30 秒、归一化 -18 LUFS）、跨语言本地化。但**不能用参考音频逐句换音色**，只能用已保存的 `voice_id` |
| **是否需要联网** | ❌ 不需要。完全离线，只依赖本机 9872 推理服务 | ✅ 必须联网，`api.breeze.blue` |
| **中文自然度** | 中文原生模型，中文语料微调，**中文是主场景** | 中文是 51 语言之一，有 8 个中文方言口音码和专门的中文分段逻辑（>500 字切 5 段、段间 0.25 s），但底层是**多语言统一模型**。实际自然度**需真实试听才能判断，文档无法回答** |
| **参数数量** | 多且细：`speed`、`seed`、`sample_steps`、`top_k`、`top_p`、`temperature`、`split_method`（6 种切句）、`lang`（11 种）、`reference_text`、`reference_audio` | 少且粗（TTS 请求体只有 5 个字段）：`text`、`model_id`、`language_code`、`instructions`、`voice_settings{guidance_scale, speed, volume, use_speaker_boost}`。**没有 seed、没有采样参数、没有切句方式、没有 top_k/top_p/temperature** |
| **稳定性** | 取决于本机进程；9872 没开就直接不可用（需手动在 9874 点「开启TTS推理WebUI」）。长文本靠 `split_method` 兜底 | 有正式 SLA 话术（503/504/`Retry-After`/错误码表/幂等 `Idempotency-Key`），但**生成请求不自动重放**，超时后是否已扣费不明确。免费档走标准队列，高峰期慢 |
| **限流** | **无**。本机单机，无并发上限、无配额、无速率限制 | 有。按档位的**并发生成数**限制（Free 标准队列 → Business Highest），Studio 与 API 共享同一池；实时 WS 另有 30 次/分钟连接限制、30 分钟会话上限。**同样输入重复请求会重复计费** |
| **鉴权 / 部署** | 无鉴权，纯 localhost HTTP | 需要 `brz_` 开头的 API key；key 最多 50 个/账户；可给单个 key 设 credits 硬上限 |
| **离线/隐私** | 文本和音频**不出本机** | 文本和音频上云。`enable_logging: false` 只是从用户可见的 history 里隐藏，**平台仍保留请求文本、生成音频和计费元数据**用于内部运维与防滥用 |
| **商用授权** | 取决于所用模型/语料的许可 | 付费档含商用；**Free 档不含商用**（`commercial_use_allowed` 字段可查） |

来源：
- GPT-SoVITS 侧：本机 `text-to-speech` 技能文档（`C:\Users\Yansunsky\.dsh\skills\text-to-speech`）
- Breeze 侧：<https://breezeblue.ai/pricing>、<https://docs.breezeblue.ai/concepts/pricing.md>、<https://docs.breezeblue.ai/reference/rate-limits.md>、<https://docs.breezeblue.ai/concepts/voices.md>、<https://docs.breezeblue.ai/guides/voice-clone.md>、<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>、<https://docs.breezeblue.ai/guides/realtime-text-to-speech.md>

---

## 10. npm SDK 与依赖

### 包信息（npm registry 实测）

| 项 | 值 |
|---|---|
| 包名 | **`@breeze.blue/sdk`**（**存在**） |
| latest 版本 | **`0.23.0`** |
| 许可 | MIT |
| 模块类型 | `"type": "module"` —— **纯 ESM，无 CommonJS 入口** |
| Node 要求 | `engines.node >= 20` |
| 运行时依赖 | **无**（`dependencies` 字段不存在；`devDependencies` 只有 `typescript` 和 `@types/node`） |
| unpacked 体积 | **239,320 字节（约 234 KB）**，30 个文件 |
| 导出 | `.` → `dist/index.js`；`./node` → `dist/node.js`（含 `play` / `save` / `stream` 辅助） |
| 仓库 | <https://github.com/breezebluestudio/BreezeBlueStudio>（`packages/breeze-typescript`） |

来源：<https://registry.npmjs.org/@breeze.blue/sdk/latest>、<https://unpkg.com/@breeze.blue/sdk@0.23.0/package.json>

### 它是不是纯 fetch 封装

**是。** 看 `dist/client.js` 的核心请求方法：

```js
async request(method, path, params, body, options) {
  // ...校验 apiKey...
  const response = await this.fetch(buildUrl(this.baseUrl, path, wireParams), {
    method,
    headers: this.buildHeaders(wireBody, options?.headers),
    body: bodyToRequestBody(wireBody),
    signal: signal.signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}
```

以及 `this.fetch = (input, init) => (fetchImpl ?? globalThis.fetch)(input, init);`

**结论：它做的就是 `fetch` + 拼 URL + 设 `xi-api-key` + JSON 序列化 + 把响应包成 `AudioResponse`。没有任何签名、加密、重试黑盒或私有协议。**

SDK 额外做的事（都可以自己实现，也可以不做）：
- 自动 camelCase ↔ snake_case 转换（`client.js` 里 `camelizeKeys` / `snakeizeKeys`）
- 给每个请求加 `x-breeze-sdk: breeze-blue-sdk/<version>` 头
- 默认 `timeout: 60_000` ms（用 AbortController 实现）
- 把错误响应翻译成 `BreezeBlueAPIError` 子类
- `AudioResponse` 包装 `.arrayBuffer()` / `.bytes()` / `.blob()` / `.contentType` / `.historyItemId`

来源：<https://unpkg.com/@breeze.blue/sdk@0.23.0/dist/client.js>

### 纯 fetch 方案可行性

**完全可行。** 一个不依赖任何包的 Node 实现大约是这样：

```js
const res = await fetch(
  `https://api.breeze.blue/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3`,
  {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id, language_code, instructions, voice_settings }),
  },
);
if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  throw new Error(`${res.status} ${err.code}: ${err.detail}`);
}
const buf = Buffer.from(await res.arrayBuffer());  // 原始音频字节
```

需要注意的三个点：
1. **`output_format` 必须放 query**，放 body 会被 `additionalProperties: false` 拒
2. **成功响应不是 JSON**，直接 `arrayBuffer()`，不要 `.json()`
3. **只有实时 WebSocket 需要 `WebSocket`**（Node 22+ 内置；Node 20 需自己传 `webSocket` 构造器）。纯 HTTP 合成不需要

来源：<https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md>、<https://unpkg.com/@breeze.blue/sdk@0.23.0/dist/client.js>

### 有没有官方的 OpenAI 兼容接口

**没有。**

- 查了官方 `openapi.json` 的**全部 27 个 path**，没有 `/v1/audio/speech` 或任何 OpenAI 风格的 TTS 端点：

```
/v1/models
/v1/text-to-speech/{voice_id}
/v1/text-to-speech/{voice_id}/with-timestamps
/v1/text-to-speech/{voice_id}/stream
/v1/text-to-speech/{voice_id}/stream/with-timestamps
/v1/text-to-speech/{voice_id}/realtime-sessions
/v1/text-to-speech/enhance
/v1/generation-jobs/{generation_job_id}
/v1/generation-jobs/{generation_job_id}/audio
/v1/voice-metadata/options
/v1/voices
/v1/voices/{voice_id}
/v1/voices/{voice_id}/tags
/v1/voice-previews/clone
/v1/voice-previews/design
/v1/voice-previews/design/stream
/v1/voice-previews/remix/presets
/v1/voice-previews/remix/prepare
/v1/voice-previews/remix
/v1/voice-previews/remix/{generation_job_id}
/v1/voice-previews/localize
/v1/voice-previews/localize/{generation_job_id}
/v1/voice-previews/{generated_voice_id}/stream
/v1/voice-previews/{generated_voice_id}/save
/v1/balance
/v1/entitlements
/v1/usage
```

- 全站文档和 OpenAPI 规范里**搜不到 `openai` / `audio/speech` 字样**（0 命中）

**即：不存在 OpenAI 兼容层，不能拿 OpenAI SDK 直连，请求/响应结构都是 Breeze 自有的。**

来源：<https://docs.breezeblue.ai/openapi.json>

---

## 11. 未确认的问题清单

以下是文档没写清、**必须有真实 API key 才能验证**的点。调研阶段不做假设。

### 鉴权 / 账户

1. **API key 的实际下发与额度**——没 key 无法确认 key 是否真能建、`/v1/api-keys/current` 返回的真实形态
2. **账户管理端点到底能不能用 API key**——`/v1/api-keys` 系列文档说"需要浏览器会话"，但 `SDK` 里 `account.currentApiKey()` 又是走 API key 的。其它 API-key 端点的边界需实测
3. **`402 API_KEY_CREDIT_LIMIT_EXCEEDED` 与 `402 BILLING_INSUFFICIENT_CREDITS` 的实际触发条件**——尤其批量结算下快照最多 300 秒陈旧，"余额够但还是被拒"是否会真实发生

### 合成行为

4. **`breeze-tts-2` 到底支持哪些语言**——文档只说 `breeze-tts-2-multilingual` 支持全部 51 种，**没有列出 `breeze-tts-2` 的语言子集**。中文到底该显式传 `breeze-tts-2` 还是 `breeze-tts-2-multilingual`，文档只给了"省略 `model_id` 时 `language_code: zh` 会选 `breeze-tts-2`"这一条旁证，**两个模型对中文的实际质量差异完全未知**
5. **`GET /v1/models` 的实际返回内容**——schema 是动态数组（`ModelResponse[]`），具体 `model_id` 清单和每个模型的 `languages[]` 只有调用了才知道
6. **同步请求的服务端超时上限**——文档未说明。SDK 客户端 timeout 是 60 s，服务端多久断、超时后是否已扣费，均未写明
7. **长文本 >2000 字符的真实行为**——文档说"直接拒绝不截断"，但具体错误码是 `VALIDATION_ERROR` 还是 `BAD_REQUEST` 未说明
8. **`instructions` 的实际生效幅度**——`guidance_scale` 1–10 的听感差异有多大，官方只给了"1–3 试起"的经验值，没有量化
9. **中英混排时的语言判定**——`language_code` 显式指定后，文本里的英文片段会被怎么读，文档未说明
10. **`volume` 与 `speed` 同时使用**是否会有相互作用，文档未说明

### 音色

11. **中文音色的实际数量和质量**——文档确认 `zh` 和 8 个方言码存在，但目录里到底有多少个中文音色、自然度如何，**必须用 key 调 `GET /v1/voices?language_code=zh` 才知道**
12. **音色克隆的中文效果**——中文 ASR 失败会返回可重试错误（不回退自动识别），实际成功率未知
13. **克隆的 5 MB 限制配"无最大时长"**——3 秒到 5 MB 之间的实际可用区间（高码率 WAV 很容易 5 MB 就超时长），文档没给建议

### 计费 / 限流

14. **各档位的具体并发数字**——文档只写 low/medium/high，真实值要 `GET /v1/entitlements` 才知道
15. **`Retry-After` 的典型值**——schema 是 0–3600 秒，实际会给多少未知
16. **每日 400 免费 credits 的领取方式**——文档说"manual claim"，但 API 里**没有对应端点**，推测只能网页领
17. **批量结算 vs 即时结算**是账户配置决定，`GET /v1/entitlements` 不返回这个字段，只能从 `balance.settlement_pending` 反推

### 错误处理

18. **`GENERATION_CAPACITY_EXCEEDED` 到底该不该重试**——错误码表说 429 + No，同页正文说 429 + "Please try again shortly"，速率限制页又建议对 5xx 退避重试。**官方文档自相矛盾**，需实测
19. **传输超时后是否已扣费**——`503`/`504` 带 `history-item-id` 时可以取回，但**不带这个头**的失败（如网络中断）是否计费，文档未说明
20. **`Retry-After` 缺失时的退避策略**——文档只说"honor when provided"，没给缺省推荐值

### SDK

21. **`@breeze.blue/sdk` 0.23.0 的跨 Node 版本表现**——`engines.node >= 20`，但实时 WS 需要 Node 22+ 的全局 `WebSocket`，否则要手动传 `webSocket`。纯 HTTP 场景不受影响
22. **SDK 版本迭代速度**——从 0.3.0 到 0.23.0 共 20+ 个版本，CHANGELOG 有 18 KB，**API 可能还在快速变动**，纯 fetch 自己调反而更稳

---

## 12. 真机验证（2026-11-07，有 key 之后）

> 全部用 Node 内置 `fetch` 打的，没用 SDK。测试账户是一个新建的 Free 档账号。

### 12.0 先记一个本机坑

**PowerShell 的 `Invoke-RestMethod` 打不通 `api.breeze.blue`** —— 直接报
`The SSL connection could not be established ... Authentication failed, see inner exception.`
同一个 key、同一台机器，**Node 的 `fetch` 一次就 200**。
所以验证脚本和最终实现都必须走 Node `fetch`，别用 pwsh 下结论。
（`node --version` 需 ≥ 18 才有全局 fetch。）

### 12.1 账户端点：可用，且是纯 API key 鉴权

第 11 章第 2 条的疑问解除：`/v1/balance`、`/v1/entitlements`、`/v1/api-keys/current` **都能用 `xi-api-key` 直接调**，不需要浏览器会话。

`GET /v1/balance`（真实响应，`creds` 字段已省略）:

```json
{"settlement_pending": false, "settlement_interval_seconds": 60, "balance": 1772.2,
 "balance_millicredits": 1772200, "scale": 1000,
 "topups": [{"id": "led_x59zn5zg6kqz", "amount": 400.0, "description": "daily claim credits"},
            {"id": "led_ked85t2bbex5", "amount": 1000.0, "description": "signup bonus credits"},
            {"id": "led_2ar94tk9yk55", "amount": 400.0, "description": "Onboarding survey welcome reward"}],
 "charges": []}
```

比文档多出两个字段：**`scale: 1000`**（millicredits 的换算基数）和 **`charges[]`**（文档没提，实测是空数组）。
`balance` 是**小数**（1772.2），不是整数 —— 别用整数解析。

`GET /v1/entitlements`（Free 档实况）:

```json
{"plan_code": "free", "status": "free", "billing_interval": null, "cancel_at_period_end": false,
 "current_period_start": null, "current_period_end": null, "monthly_creative_credits": 0,
 "saved_voice_limit": 5, "saved_project_limit": 10,
 "max_concurrent_generations": 1, "studio_long_form_access": false, "commercial_use_allowed": false}
```

⚠️ **`max_concurrent_generations: 1`** —— Free 档实打实只能同时合成 1 条。
第 11 章第 14 条有了答案：这个值必须当**硬约束**设计，不能当参考值。
⚠️ `commercial_use_allowed: false` —— Free 档确实不能商用。

`GET /v1/api-keys/current` 比文档多一层包装（字段在 **`api_key`** 下，不是顶层）：

```json
{"api_key": {"id": "key_xxxxxxxxxxxx", "name": "…", "prefix": "brz_AAAA1111", "status": "active",
             "credit_limit": null, "credit_used": 0.0, "credit_reserved": 0.0, "credit_remaining": null}}
```

### 12.2 模型：`breeze-tts-2` 只有 en + zh

第 11 章第 4、5 条解除。`GET /v1/models` 返回**裸数组**（不是 `{models:[...]}`），只有两个模型：

| model_id | languages |
|---|---|
| `breeze-tts-2` | **en, zh**（就这两个） |
| `breeze-tts-2-multilingual` | 51 种，含 zh、ja、ko、en… |

**结论：中文直接省略 `model_id` 或显式传 `breeze-tts-2`。** 不需要用 multilingual。
（质量差异本次没做 AB 对比 —— 那要人耳听，不是脚本能判的。但既然 `zh` 是 `breeze-tts-2` 的一等公民，
没有理由绕去 multilingual。）

### 12.3 音色：中文 530 条，普通话 315 条

第 11 章第 11 条解除 —— 而且**数量级远超预期**：

| 查询 | total | has_more |
|---|---|---|
| `?language_code=zh&page_size=100` | **530** | true |
| `?language_code=zh&accent_mode=unmarked&page_size=100` | **315** | true |

默认排序下前几条（可见命名风格偏二次元/角色向）：

| voice_id | name | gender | age |
|---|---|---|---|
| `voc_2b6gng7k39k9` | 人鱼大姐姐 | female | young |
| `voc_rn489h83rcvs` | 大肥鱼（偶像版） | female | young |
| `voc_rh6e8hdbraz6` | 哈基米娘 | female | young |
| `voc_b86bfwct4cjn` | 香农小姐 | female | young |

⚠️ **配置页不能做成「一个下拉框塞全部」** —— 315 条没法用。
`page_size` 上限 100，所以要拿全部普通话至少翻 4 页。

### 12.4 同步合成：一次就通

```
POST /v1/text-to-speech/voc_2b6gng7k39k9?output_format=mp3
xi-api-key: <key>
{"text": "你好，我是沃雅妮莎。今天也要好好休息哦。", "language_code": "zh"}
```

| 项 | 实测值 |
|---|---|
| 状态 | 200 |
| `content-type` | `audio/mpeg` |
| 响应头 `history-item-id` | `job_atqbeauuuut5`（文档写的是 `history-item-id`，实测确实有） |
| 字节数 | 64,896 |
| 耗时 | **2,866 ms**（21 个汉字） |
| 文件头 | `ff f3 c4 c4 00 4d 74 31` —— **无 ID3 标签的裸 MPEG 帧同步字**（`0xFFF3`） |

⚠️ 文件头这条对 `voiceout.js` 很关键：现有的 `validateVoiceBytes` 对 mp3 认两种头
（`ID3` 或 `0xFF & 0xE0`），**Breeze 的 mp3 走第二条分支，能过**。但别假设它一定有 ID3。

### 12.5 WAV 输出可用（推荐用它，不是 mp3）

| format | 状态 | 字节 | content-type | 文件头 |
|---|---|---|---|---|
| `wav` | 200 | 61,484 | `audio/wav` | `52 49 46 46 ... 57 41 56 45` = `RIFF`…`WAVE` ✅ |
| `wav_24000` | 200 | 84,524 | `audio/wav` | `RIFF`…`WAVE` ✅ |

两个都是标准 RIFF/WAVE，**现有 `validateVoiceBytes` 的 WAV 分支能完整校验通过**。
12.4 的 mp3 是 64.9 KB / 21 字，12.5 的 wav 是 61.5 KB / 9 字 —— 量级正常。

> ⚠️ 注意 `wav_24000` 那次耗时 **12,057 ms**，`wav` 是 2,731 ms。同一句话、同一次会话里差 4 倍，
> 而两者只差一个采样率。**原因未查明**（Free 档并发 1 + 标准队列，很可能只是排队）。
> 所以：**不要根据单次耗时做性能结论**，也别把超时设在 15 秒附近。

### 12.6 错误形态：全部实测（这是写重试逻辑的依据）

| 场景 | HTTP | `code` | `detail` |
|---|---|---|---|
| voice_id 不存在 | **404** | `RESOURCE_NOT_FOUND` | `Voice not found.` |
| `text: ""` | **422** | `VALIDATION_ERROR` | `String should have at least 1 character` + `meta.errors[]` |
| `output_format` 写进 body | **422** | `VALIDATION_ERROR` | `Extra inputs are not permitted` + `meta.errors[].type = "extra_forbidden"` |
| `output_format=xyz` | **400** | `BAD_REQUEST` | `Unsupported output_format. 'xyz' is not a known encoding...` |
| 1200 字文本 | **422** | `VALIDATION_ERROR` | `text must be 1000 characters or fewer` |

**四条结论：**

1. 第 11 章第 7 条解除：超长是 **422 `VALIDATION_ERROR`**，不是 `BAD_REQUEST`。
   → 实现要**在本地先判长度**，别等 422 —— 那是一次无意义的网络往返。
2. 第 11 章正文强调的「`output_format` 在 query 不在 body」**实测坐实**（`extra_forbidden`）。
3. 404 和 400/422 都**不该重试**（配错的 key/voice/格式重试一百次也一样）。
4. 错误体是**扁平 JSON**，`code` / `detail` / `error` 三个字段都能直接用。
   失败时是 JSON，成功时是二进制 —— **靠 `content-type` 分流**（见 12.7）。

### 12.7 实现上的硬结论

| # | 结论 | 依据 |
|---|---|---|
| 1 | **必须用 `fetch`，不能 `Invoke-RestMethod`** | 12.0 |
| 2 | **成功与否靠 `content-type` 判**，不要 `res.json()` 硬解 | 12.4 成功是 `audio/*`，12.6 失败是 `application/json` |
| 3 | **`output_format` 放 query** | 12.6 |
| 4 | **本地先做 1000 字符校验** | 12.6 |
| 5 | **中文不传 `model_id`**，或显式 `breeze-tts-2` | 12.2 |
| 6 | **并发上限当 1 用**（Free 档） | 12.1；要用 `/v1/entitlements` 读，别写死 |
| 7 | **超时给足**（≥30 s），15 s 级别会误杀 | 12.5 的 12 s 观测 |
| 8 | **默认用 `output_format=wav`** | 12.5；WAV 能过现有全部校验，且不依赖解码器 |
| 9 | **404/400/422 不重试**；429/5xx 才退避 | 12.6 + 错误码表 |
| 10 | **`balance` 是浮点**，别 `parseInt` | 12.1 |

### 12.8 仍然没验证的

- 中文两个模型的**主观质量差异**（要人耳）
- `instructions` / `guidance_scale` 的**听感幅度**
- 429 的 `Retry-After` 实际值（本次没撞到）
- 传输中断后**是否已扣费**（`settlement_pending` 是 true，但 `charges[]` 为空，
  且 `total_charges` 要等 60 秒结算才出 —— 单次请求看不出扣了没）

### 12.9 长文本：1000 字满额实测

用 1000 个「字」重复填满上限：

| 项 | 实测值 |
|---|---|
| 状态 | 200 |
| 耗时 | **5,803 ms** |
| 字节 | 144,384 |
| content-type | `audio/mpeg` |

**结论**：1000 字只比 21 字慢一倍多，**不是线性增长** —— 印证了文档说的
「`language_code: zh` 且非流式时 >500 字会被切成最多 5 段」，
而分段在服务端是**并行合成再拼接**的（段间加 0.25 s 静音）。

所以超时设 30 秒对 1000 字是够的，但要留余量（Free 档并发 1，前面有别人排队时会更慢）。

⚠️ 顺带记一笔：这 1000 字按 2 units/字 计，约 **200 credits**，$0.6。
日额度如果定 1000 汉字，等于**每天最多一次满额请求** —— 这个默认值偏紧，
实际用起来大概率要调大。

---

## 附：关键 URL 索引

| 内容 | URL |
|---|---|
| 文档索引 | <https://docs.breezeblue.ai/llms.txt> |
| OpenAPI 全量规范 | <https://docs.breezeblue.ai/openapi.json> |
| API 总览（base URL / 鉴权 / 内容类型） | <https://docs.breezeblue.ai/api-reference/introduction.md> |
| 鉴权细节 | <https://docs.breezeblue.ai/authentication.md> |
| **TTS 转换（最重要）** | <https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech.md> |
| TTS 使用指南 | <https://docs.breezeblue.ai/guides/text-to-speech.md> |
| 输出格式 | <https://docs.breezeblue.ai/concepts/output-format.md> |
| 流式 | <https://docs.breezeblue.ai/concepts/streaming.md> |
| 音色概念 | <https://docs.breezeblue.ai/concepts/voices.md> |
| 列出音色 | <https://docs.breezeblue.ai/api-reference/voices/list-voices.md> |
| 音色元数据选项 | <https://docs.breezeblue.ai/api-reference/voices/list-voice-metadata-options.md> |
| 克隆音色 | <https://docs.breezeblue.ai/guides/voice-clone.md> |
| 列出模型 | <https://docs.breezeblue.ai/api-reference/models/list-models.md> |
| 多语言与口音 | <https://docs.breezeblue.ai/concepts/multilingual.md> |
| 计费 | <https://docs.breezeblue.ai/concepts/pricing.md> |
| 价格页 | <https://breezeblue.ai/pricing> |
| 速率限制 | <https://docs.breezeblue.ai/reference/rate-limits.md> |
| 错误码 | <https://docs.breezeblue.ai/reference/errors.md> |
| 指令撰写 | <https://docs.breezeblue.ai/guides/voice-instruction-prompting.md> |
| 余额查询 | <https://docs.breezeblue.ai/api-reference/account/get-account-balance.md> |
| 权益查询 | <https://docs.breezeblue.ai/api-reference/account/get-account-entitlements.md> |
| 实时 TTS | <https://docs.breezeblue.ai/guides/realtime-text-to-speech.md> |
| npm 包元数据 | <https://registry.npmjs.org/@breeze.blue/sdk/latest> |
| SDK 源码（client.js） | <https://unpkg.com/@breeze.blue/sdk@0.23.0/dist/client.js> |
