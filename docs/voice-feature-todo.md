# CanvasFlow Voice Feature TODO

本文档用于跟踪 CanvasFlow 从“接收语音转写文本”发展到“可稳定演示、可接入真实 ASR/TTS 的语音运行时”。规划参考 `SuperdeMan/cockpit-agent` 的分层设计，但在 CanvasFlow 的 TypeScript、Fixture、Gateway 和 Policy Gate 架构内重新实现。

## 目标

完整链路应支持：

```text
麦克风或预录音频
  -> 录音 / VAD 端点
  -> Fixture / Live ASR Provider
  -> partial / final 转写与置信度
  -> 用户确认或修正
  -> Agent Gateway / Policy Gate
  -> TaskState 与 UISpec
  -> Fixture / Live TTS Provider
  -> 播放队列 / 停止 / 打断
```

比赛演示必须同时提供两条路径：

- 稳定路径：预录音频 -> Fixture 固定转写 -> 用户确认 -> Agent。
- 真实路径：浏览器 Web Speech -> 用户确认 -> Agent。
- 扩展路径：音频上传 -> Fixture / Mock / Live Voice Provider -> 用户确认 -> Agent。

## 设计原则

- 语音是输入输出通道，不是新的任务执行通道。
- 文本和语音共用 Planner、Gateway、Policy Gate、Confirmation 和 UISpec Composer。
- ASR 可以识别和规范化文本，但不能直接执行导航、消息、座舱或记忆动作。
- 语音确认只能裁决当前有效的 `pendingConfirmation`，不能绕过权限检查。
- 流式 ASR/TTS 是增强路径，批处理和文本输入必须始终可回退。
- 所有 Provider 结果必须经过 Schema 校验；失败时诚实降级，不伪造成功。
- 唤醒前音频不得上传；用户原始音频默认不持久化。
- 声纹只可用于个性化，不能作为权限、支付或高风险动作凭证。

## 参考项目能力取舍

从 `SuperdeMan/cockpit-agent` 借鉴：

- 流式 ASR 的 `partial` / `final` 协议。
- 批处理 ASR 回退。
- VAD 自动断句和 pre-roll 防首字丢失。
- 显式语音状态机。
- 流式 TTS、播放队列和 barge-in。
- 连续追问窗口、误唤醒回收和拒识策略。
- 语音指标与完整 E2E。

当前阶段不直接照搬：

- 多 ASR/TTS 厂商运行时热切换。
- 声纹身份系统。
- 端到端 Speech-to-Speech 直连。
- 完整本地 KWS 模型构建链。
- 面向大量领域 Agent 的车机语音基础设施。

## 当前基线

以下能力已经存在，不需要重复实现：

- [x] Agent 输入支持 `source: "voice"`。
- [x] Agent 输入支持 `confidence: 0..1`。
- [x] API Client 可以提交语音来源的转写文本。
- [x] `confidence < 0.6` 时不自动应用乘客和航班字段。
- [x] 低置信度输入会提示用户确认或编辑。
- [x] 客户端声明 `supportsTts` 能力。
- [x] Agent 响应包含 `assistant.shouldSpeak`。
- [x] 浏览器 Web Speech 麦克风输入、可编辑转写和文字兜底。
- [x] 浏览器 `speechSynthesis` 播报、停止和按键打断。
- [x] 纯逻辑语音状态机和依赖注入测试。
- [x] 三条预录 WAV 的演示抽屉回放和草稿保护。
- [x] Fixture / Mock 批处理 Voice Provider 与增强音频样本。
- [x] `POST /v1/voice/transcriptions` JSON 和 multipart 批处理接口。

当前尚未实现服务端 Live ASR、WebSocket 流式转写、MediaRecorder 上传客户端、VAD、服务端 TTS Provider 和连续追问。

## P0：语音协议

- [x] 在 `packages/schema/src/voice.ts` 定义 `VoiceTranscriptionResult`。
- [x] 结果至少包含 `audioId`、`transcript`、`confidence`、`language`、`durationMs`、`provider` 和 `warnings`。
- [x] 定义流式转写事件：`started`、`partial`、`final`、`error` 和 `closed`。
- [x] `partial` 至少包含 `sessionId`、`sequence` 和当前累计文本。
- [x] `final` 至少包含最终文本、置信度、音频时长和实际 Provider。
- [x] 定义 `POST /v1/voice/transcriptions` 的结构化请求元数据和响应 Schema。
- [ ] 定义 `WS /v1/voice/transcriptions/stream` 的客户端与服务端消息 Schema。
- [ ] 定义 TTS 请求、音色、音频 chunk 和完成事件 Schema。
- [x] 定义错误码：
  - `VOICE_PERMISSION_DENIED`
  - `AUDIO_TOO_SHORT`
  - `AUDIO_TOO_LONG`
  - `UNSUPPORTED_AUDIO_FORMAT`
  - `NO_SPEECH_DETECTED`
  - `TRANSCRIPTION_FAILED`
  - `TRANSCRIPTION_TIMEOUT`
  - `LOW_CONFIDENCE`
  - `STREAM_DISCONNECTED`
  - `TTS_FAILED`
  - `TTS_TIMEOUT`
  - `PLAYBACK_FAILED`
- [ ] 明确浏览器录音格式优先使用 `audio/webm;codecs=opus`。
- [x] Fixture 至少支持 PCM WAV。
- [x] 原始音频不得进入 `TaskState`。
- [x] 为合法结果、空转写、非法置信度和未知错误增加 Schema 测试。

### P0 验收

- [x] 所有结构化语音请求元数据、Provider 结果和 HTTP 响应均经过 Zod 校验。
- [x] Agent 仍只接收已转写的文本，不直接解析音频。
- [ ] Schema 测试覆盖成功和主要错误分支。

## P0：Voice Provider

- [x] 在 `packages/tools` 定义统一的 `VoiceProvider` 接口。
- [x] Provider 输入包含音频字节、MIME、语言、任务请求 ID 和可选 Fixture ID。
- [x] Provider 输出必须符合 `VoiceTranscriptionResult`。
- [x] 将批处理能力定义为 `transcribe()`；流式 `transcribeStream()` 留待 WebSocket PR。
- [ ] 流式 Provider 统一输出累计文本，避免前端处理不同厂商的 delta 语义。
- [ ] 支持 `fixture`、`mock`、`live` 三种模式。（已完成 `fixture` / `mock`，`live` 只允许显式注入）
- [ ] 在 Provider registry 中注册语音转写工具。
- [ ] 校验返回结果的 Provider 模式和请求元数据。
- [ ] 设置最大文件大小和最长录音时长。
- [ ] 支持超时和 `AbortSignal`。
- [ ] 将底层异常转换成稳定的语音错误码。
- [x] 默认不持久化、不打印原始音频。
- [x] 为模式校验、超时、非法结果和 Provider 异常增加测试。
- [ ] 定义 `TtsProvider`，支持批处理 `synthesize()` 和可选流式 `synthesizeStream()`。
- [ ] TTS Provider 输出明确采样率、通道数、编码格式、音色和模型。

### 建议文件

```text
packages/tools/src/voice.ts
packages/tools/src/voice-fixture.ts
packages/tools/src/voice-live.ts
packages/tools/src/voice.test.ts
packages/tools/src/tts.ts
packages/tools/src/tts-fixture.ts
packages/tools/src/tts.test.ts
packages/tools/src/registry.ts
```

## P0：语音 Fixture（zkr 负责）

- [x] 创建 `fixtures/airport-pickup/voice/`。
- [x] 添加清晰语音：`接妈妈和豆豆，航班 MU5102`。
- [x] 添加缺少航班号语音：`我现在要去机场接妈妈和豆豆`。
- [x] 添加带噪但可部分识别的低置信度语音。
- [x] 添加只有环境噪声的无人声样本。
- [x] 添加固定误识别样本，验证编辑转写流程。
- [x] 添加固定超时 Fixture。
- [x] 为清晰语音增加可重放的 `partial` 序列，模拟边说边上屏。
- [x] 添加短噪声、截断语句和航班号易错读法样本。
- [ ] 增加一组 Fixture TTS 输出，至少覆盖“请补充航班号”和低置信度提示。
- [x] 编写 `manifest.json`，记录文件、结果、置信度、语言和 outcome。
- [x] 使用稳定 `fixtureId` 或音频 SHA-256 匹配结果，不依赖文件名猜测。
- [x] 编写 Fixture README，注明录音内容、采样率、来源和预期行为。
- [x] 确认音频不包含真实电话号码、地址或其他私人信息。
- [x] 为全部 Fixture 增加确定性重放测试。
- [x] 未知音频必须返回明确错误，不得猜测转写。

## 语音模块负责人范围

当前语音相关工作由 zkr 负责整体推进，包含以下四层：

- [x] `packages/schema`：批处理语音请求元数据、转写结果和错误协议。
- [x] `packages/tools` 与 `fixtures/airport-pickup/voice`：Fixture / Mock Voice Provider、固定转写、噪声和失败样本。
- [ ] `apps/demo` 与 Agent API：Web Speech、Fixture 回放、批处理上传接口和 `source: "voice"` 已完成；MediaRecorder 上传客户端待完成。
- [ ] 语音运行时：流式 ASR、VAD、状态机、TTS 队列、停止、重播和打断。
- [ ] TTS 与语音 confirmation：播报和高风险确认边界。

其他协作者可以提供 ASR 服务适配、视觉 UI 或测试协助，但语音模块的协议、Fixture 行为和最终验收由 zkr 统一确认。

### 建议目录

```text
fixtures/airport-pickup/voice/
  clear-airport-pickup.wav
  missing-flight-number.wav
  noisy-airport-pickup.wav
  no-speech.wav
  misunderstood-flight.wav
  timeout.wav
  short-noise.wav
  truncated-utterance.wav
  flight-number-spoken-digits.wav
  manifest.json
  README.md
```

### Fixture 验收矩阵

| Fixture | 预期结果 | Agent 行为 |
| --- | --- | --- |
| `clear-airport-pickup` | 固定转写，置信度约 `0.96` | 可确认后创建完整任务 |
| `missing-flight-number` | 固定转写，高置信度 | 创建任务并要求补充航班号 |
| `noisy-airport-pickup` | 固定转写，置信度 `< 0.6` | 不写入槽位，要求确认或编辑 |
| `no-speech` | `NO_SPEECH_DETECTED` | 不创建任务，可重新录音 |
| `misunderstood-flight` | 固定错误转写 | 用户编辑后再提交 |
| `timeout` | `TRANSCRIPTION_TIMEOUT` | 显示重试和文本兜底 |
| `short-noise` | 短噪声或 filler | 静默拒识，不创建任务 |
| `truncated-utterance` | 不完整语句 | 保留转写并要求补充，不猜测槽位 |
| `flight-number-spoken-digits` | `MU 五一零二` | 规范化并显示为 `MU5102` |

## P0：语音 HTTP API

- [x] 实现 `POST /v1/voice/transcriptions`。
- [ ] 实现 `WS /v1/voice/transcriptions/stream`。
- [x] 支持 `multipart/form-data` 音频上传。
- [x] Fixture 模式支持通过预录音频或 `fixtureId` 调用相同接口。
- [ ] 校验 MIME、空文件、文件大小和录音时长。（MIME、空文件和文件大小已完成；独立时长解析待完成）
- [x] 根据 `AGENT_VOICE_MODE` 选择 Voice Provider。
- [ ] 增加请求超时和取消处理。
- [x] 返回统一结果，不暴露 Provider 私有响应。
- [ ] 日志仅记录请求 ID、音频 ID、时长、Provider 和状态。
- [x] 不在日志中输出音频字节、密钥或完整敏感转写。
- [x] 为成功、低置信度、无人声、超时、格式错误和超大文件增加 API 测试。
- [ ] 流式接口支持 `start`、二进制音频 chunk、`commit` 和 `cancel`。
- [ ] 流断开时可使用当前录音回退批处理转写，且不得重复提交 Agent。
- [ ] 为消息乱序、重复 `commit`、断线、取消和超时增加测试。

### P0 验收

- [x] Fixture 转写 API 在无网络、无密钥环境下可确定性运行。
- [x] 错误响应具有稳定的 HTTP 状态和业务错误码。
- [ ] 原始音频不会写入 SQLite。

## P0：前端录音与确认

- [ ] 增加麦克风按钮，且只在用户点击后申请权限。
- [ ] 使用 `getUserMedia({ audio: true })` 获取音频流。
- [ ] 使用 `MediaRecorder` 录制音频。
- [ ] 第一阶段使用 `MediaRecorder` 完成兼容路径；VAD 阶段升级为共享 PCM 音频流。
- [ ] 实现以下状态：
  - `idle`
  - `requesting-permission`
  - `recording`
  - `listening`
  - `transcribing`
  - `reviewing`
  - `submitting`
  - `speaking`
  - `followup`
  - `error`
- [ ] 显示录音时长和明确的录音中状态。
- [ ] 提供停止、取消和重新录音操作。
- [ ] 设置最长录音时间，例如 15 秒。
- [ ] 停止或取消后立即释放全部麦克风音轨。
- [ ] 处理权限拒绝和浏览器不支持 `MediaRecorder` 的情况。
- [ ] 转写完成后先显示可编辑文本，不直接执行 Agent 动作。
- [ ] 流式 ASR 的 partial 文本实时显示，final 到达后才允许提交。
- [ ] partial 只用于视觉反馈，不得触发 Planner 或 Provider 副作用。
- [ ] 高置信度结果提供“确认并发送”。
- [ ] 中等置信度结果提示“可能听错”，要求确认。
- [ ] 低置信度结果强制编辑或重新录音。
- [ ] 无人声或转写失败时保留文本输入兜底。
- [ ] 用户确认后调用现有 Agent API，并设置 `source: "voice"`。
- [ ] Event console 显示输入来源和置信度。

### 建议阈值

```text
confidence >= 0.85       显示转写，允许一键确认
0.6 <= confidence < 0.85 显示不确定提示，要求确认
confidence < 0.6         强制编辑或重新录音
```

### 建议文件

```text
apps/demo/src/useVoiceRecorder.ts
apps/demo/src/VoiceInput.tsx
apps/demo/src/voice-client.ts
apps/demo/src/voice/voice-state.ts
apps/demo/src/App.tsx
```

## P0：Fixture 演示入口

- [ ] 在 Fixture 模式增加语音样本选择器。
- [ ] 提供“播放样本”和“使用该语音输入”操作。
- [ ] 清晰标记“预录语音演示”，不得暗示为实时 ASR。
- [ ] 生产或 Live 模式隐藏 Fixture 选择器。
- [ ] 清晰语音可进入完整接机流程。
- [ ] 带噪语音可展示低置信度确认。
- [ ] 无人声可展示可恢复错误。
- [ ] 超时样本可展示重试和文本兜底。

## P1：Live ASR Provider

- [ ] 选择真实 ASR 服务并实现 Adapter。
- [ ] 凭证只通过环境变量注入。
- [ ] 增加 endpoint host allowlist。
- [ ] 设置连接超时、整体超时和响应体大小限制。
- [ ] 严格校验 Provider 响应。
- [ ] 支持中文 `zh-CN`。
- [ ] 正确保留航班号中的英文和数字。
- [ ] 规范化 `MU 五一零二`、`MU 5102` 等常见转写形式。
- [ ] Live Provider 不可用时降级到文本输入，不伪造成功。
- [ ] Live 模式缺少配置时明确禁用语音或拒绝启动。
- [ ] CI 使用 Mock Contract 测试，不调用外部服务。
- [ ] Live Provider 优先支持流式识别，无法流式时明确回退批处理。
- [ ] 流式断开后使用同一轮音频做一次批处理兜底，不重复计入用户轮次。
- [ ] 记录首个 partial、final 和总转写时延。

### 建议环境变量

```text
AGENT_VOICE_MODE=fixture|mock|live
AGENT_VOICE_ENDPOINT=
AGENT_VOICE_API_KEY=
AGENT_VOICE_MODEL=
AGENT_VOICE_ALLOWED_HOSTS=
AGENT_VOICE_TIMEOUT_MS=10000
AGENT_VOICE_MAX_BYTES=
AGENT_VOICE_MAX_DURATION_MS=15000
```

## P1：VAD 与音频管线

- [ ] 引入 VAD，将 speech start/end 与 ASR 会话解耦。
- [ ] 第一版可使用可替换的简单能量阈值；稳定版采用 Silero VAD 或等价实现。
- [ ] 使用单条共享 `MediaStream`，避免录音、VAD 和后续 KWS 分别占用麦克风。
- [ ] 统一启用并测试 echo cancellation、noise suppression 和 auto gain control。
- [ ] 增加 PCM ring buffer，在 VAD 判定后回取短 pre-roll，避免首字丢失。
- [ ] 增加静音尾配置，默认约 700 至 900ms。
- [ ] 增加最短有效语音时长，过滤点击声和短噪声。
- [ ] VAD 失败时回退手动停止录音，不阻断文本输入。
- [ ] 页面卸载、关闭语音或权限撤销时释放共享音频流。

### 建议文件

```text
apps/demo/src/voice/vad-engine.ts
apps/demo/src/voice/pcm-ring.ts
apps/demo/src/voice/audio-session.ts
```

## P1：语音状态机与打断

- [ ] 将语音交互状态集中在纯逻辑状态机中，UI 和音频设备作为可注入外设。
- [ ] 状态至少包含 `IDLE`、`LISTENING`、`THINKING`、`REVIEWING`、`SPEAKING`、`FOLLOWUP` 和 `ERROR`。
- [ ] `LISTENING -> REVIEWING` 由 final 转写触发。
- [ ] 用户确认转写后进入 `THINKING`，不可在 partial 阶段提交。
- [ ] TTS 开始和结束必须驱动 `SPEAKING` 与 `FOLLOWUP`。
- [ ] 播报中检测到持续人声时停止 TTS，并进入新一轮聆听。
- [ ] barge-in 设置最短持续时长，避免短噪声停止播报。
- [ ] 打断后不得重复上一个 Agent action 或 confirmation。
- [ ] `pendingConfirmation` 存在时，只接受明确且高置信度的确认/取消口令。
- [ ] THINKING、SPEAKING 等状态增加安全超时，防止永久卡死。
- [ ] 状态机使用 fake clock 和依赖注入进行完整单测。

### 建议文件

```text
apps/demo/src/voice/voice-loop.ts
apps/demo/src/voice/voice-loop.test.ts
apps/demo/src/voice/voice-controller.ts
```

## P1：TTS 反馈与播放队列

- [ ] 前端消费现有 `assistant.shouldSpeak`。
- [ ] P0 可使用浏览器 `speechSynthesis` 完成基础播报。
- [ ] P1 增加 `TtsProvider` 和服务端批处理或流式 TTS 接口。
- [ ] 支持文本增量输入、音频 chunk 输出和播放完成事件。
- [ ] 增加 PCM/音频播放队列，避免 chunk 间断裂。
- [ ] 增加起播缓冲、underrun 处理和播放失败回退。
- [ ] 增加语音播报开关并保存用户选择。
- [ ] 新播报开始前停止上一段播报。
- [ ] 页面卸载时停止播报。
- [ ] 提供重新播放和停止播放。
- [ ] 浏览器不支持 TTS 时保持完整文本体验。
- [ ] 不自动播报敏感信息。
- [ ] barge-in 或用户点击停止时立即清空播放队列。
- [ ] 不得把已取消的旧响应继续播完。
- [ ] 为关闭播报、`shouldSpeak: false` 和重复响应增加测试。

## P1：语音确认

- [ ] 明确允许语音完成的 confirmation 类型。
- [ ] 语音确认只能作用于当前 `pendingConfirmation`。
- [ ] 低置信度语音不得执行 confirmation。
- [ ] 高风险动作仍显示可见确认结果。
- [ ] 语音确认记录 `confirmationType: "voice"`。
- [ ] 过期 confirmation 返回 `CONFIRMATION_EXPIRED`。
- [ ] 重复语音确认保持幂等。
- [ ] “确认”和“取消”必须绑定当前 confirmation ID，不作为普通全局意图。
- [ ] ASR partial、低置信度 final 和声纹识别结果均不能直接确认动作。

## P2：免唤醒连续对话

- [ ] TTS 结束后开启可配置的 follow-up 窗口，例如 8 秒。
- [ ] follow-up 窗口内检测到人声可免再次点击麦克风。
- [ ] 窗口超时后回到普通待机状态并释放不需要的资源。
- [ ] 支持“没事了”“不用了”等本地退出词，且不上传云端。
- [ ] 拒绝 filler、短噪声和明显非受话语句，不落库、不修改任务。
- [ ] 真歧义语句生成澄清 UI，明确语句不额外反问。

## P3：本地唤醒词

- [ ] 唤醒功能默认关闭并由用户显式开启。
- [ ] 唤醒前音频只在浏览器本地处理。
- [ ] 选择可替换的 KWS 实现，并将 KWS 与语音状态机解耦。
- [ ] 唤醒成功后再开启 ASR 上传。
- [ ] 增加误唤醒静默回收。
- [ ] TTS 播报助手名称时抑制自唤醒，但不影响用户显式打断。
- [ ] 将模型文件版本、SHA-256 和获取脚本纳入文档。

## P3：声纹与 S2S（非比赛必需）

- [ ] 声纹只用于选择家庭成员偏好，不用于权限认证。
- [ ] 识别不确定时回退默认用户，不做身份断言。
- [ ] 原始声纹音频和 embedding 使用独立隐私策略。
- [ ] S2S 默认关闭，开启前明确提示原始音频可能上传。
- [ ] S2S 只处理闲聊或常识；工具执行必须交回确定性 Agent 主链。
- [ ] confirmation 永远由 CanvasFlow Gateway 和 Policy Gate 裁决。

## 语音可观测与指标

- [ ] 记录 `recording_started`、`speech_started`、`speech_ended`、`partial_received`、`final_received`。
- [ ] 记录 `low_confidence`、`no_speech`、`stream_fallback`、`tts_started`、`tts_stopped`、`barge_in`。
- [ ] 记录首个 partial 时延、final 时延、TTS 首音时延和整轮耗时。
- [ ] 指标不得包含音频字节、完整敏感转写、凭证或私人标识。
- [ ] Fixture E2E 对关键指标做确定性断言。

## 安全与隐私

- [ ] UI 明确显示何时正在录音。
- [ ] 禁止后台持续监听。
- [ ] 默认不持久化用户原始音频。
- [ ] 唤醒、VAD 等本地检测不得在未授权时上传音频。
- [ ] 只允许仓库内的虚构 Fixture 音频进入版本控制。
- [ ] 限制上传文件大小、时长、格式和请求频率。
- [ ] 对转写文本设置长度限制。
- [ ] 防止文件名和音频元数据注入日志或路径。
- [ ] README 写明音频保留策略和 Fixture 边界。
- [ ] 提交前扫描密钥、私人录音和个人数据。

## 测试 TODO

- [ ] Schema：成功结果和全部错误码。
- [ ] Provider：固定音频得到固定转写。
- [ ] Provider：同一 Fixture 重放结果一致。
- [ ] Provider：未知音频不猜测结果。
- [ ] API：合法 WAV 上传成功。
- [ ] API：拒绝空文件、不支持格式、超大和超长音频。
- [ ] API：Provider 超时和失败返回稳定错误。
- [ ] UI：权限拒绝后仍可使用文本输入。
- [ ] UI：停止和取消后释放音轨。
- [ ] UI：低置信度必须确认或编辑。
- [ ] Agent：低置信度不应用任务槽位。
- [ ] Agent：用户修正后正常创建任务。
- [ ] E2E：清晰 Fixture 创建接机任务。
- [ ] E2E：带噪 Fixture 触发确认。
- [ ] E2E：无人声 Fixture 不创建任务。
- [ ] E2E：转写超时可重试。
- [ ] 流式 ASR：partial 不触发任务，final 只提交一次。
- [ ] 流式 ASR：断线后批处理回退且不重复提交。
- [ ] VAD：speech start/end、静音尾和短噪声过滤。
- [ ] 状态机：所有合法迁移、超时恢复和关闭清理。
- [ ] TTS：队列播放、停止、重播和旧响应取消。
- [ ] Barge-in：持续人声停止播报并进入新一轮聆听。
- [ ] Confirmation：低置信度语音不能接受或拒绝待确认动作。
- [ ] E2E：所有语音控件可通过键盘操作。
- [ ] E2E：移动端录音状态不溢出页面。

## 文档与演示

- [ ] 更新根 README 的语音运行方式和环境变量。
- [ ] 更新 `docs/competition-demo-script.md`，加入 30 至 45 秒语音演示。
- [ ] 在架构图中增加 `Voice Capture -> ASR Provider -> Agent Input`。
- [ ] 架构图补充 `VAD`、`ASR stream`、`TTS Provider`、`Playback Queue` 和 `Policy Gate`。
- [ ] 明确 Fixture ASR 与 Live ASR 的区别。
- [ ] 文档记录置信度阈值和确认规则。
- [ ] 准备清晰语音 happy-path 录像。
- [ ] 准备带噪语音 fallback 录像。
- [ ] 将语音验收加入 competition release checklist。

## 推荐 PR 拆分

### PR 1：`feat/voice-contracts-fixtures`

负责人：zkr。

- Voice Schema。
- Voice Provider 接口。
- Fixture Provider。
- 预录 WAV、manifest 和 README。
- 确定性重放、噪声、无人声和超时测试。

### PR 2：`feat/voice-transcription-api`

负责人：zkr；如需拆分，可由协作者实现 HTTP 外壳，zkr 负责协议和 Provider 行为。

- 音频上传接口。
- 输入限制和错误处理。
- Fixture Provider 接入。
- HTTP 测试。

### PR 3：`feat/voice-streaming-asr`

负责人：zkr。

- `partial` / `final` WebSocket 协议。
- 流式 Fixture Provider。
- 流式断线后的批处理回退。
- 时延指标和协议测试。

### PR 4：`feat/demo-voice-input`

负责人：zkr；前端录音 UI 可与前端协作者并行。

- 浏览器录音。
- 转写预览、编辑和确认。
- Fixture 样本选择器。
- Agent API 接入。
- UI 和 E2E 测试。

### PR 5：`feat/voice-vad-runtime`

负责人：zkr；状态机和音频管线建议独立评审。

- VAD 与共享麦克风流。
- PCM ring buffer 和 pre-roll。
- 语音状态机。
- TTS 基础播放、队列和 barge-in。
- 状态机、VAD 和播放测试。

### PR 6：`feat/voice-live-and-tts`

负责人：zkr；Live ASR 和 TTS 适配可以独立评审。

- Live ASR Adapter。
- Live TTS Adapter 和流式播放。
- 语音 confirmation。
- 文档和完整验收。

### 后续 PR：`feat/voice-handsfree`

- 连续追问窗口。
- 本地退出词和拒识策略。
- 可选本地唤醒词。
- 声纹和 S2S 仅在比赛主链稳定后单独立项。

## 最终 Definition of Done

- [ ] 用户可以通过麦克风创建或补充接机任务。
- [ ] Fixture 模式无网络、无密钥也能稳定演示。
- [ ] Live 模式可以通过受控 Provider 完成真实转写。
- [ ] 流式模式可以实时显示 partial，且 final 只提交一次。
- [ ] 所有转写在执行 Agent 动作前可见且可修正。
- [ ] 低置信度、无人声、超时和权限拒绝均可安全恢复。
- [ ] 语音与文本共用 Planner、Gateway、Policy Gate 和 UISpec Composer。
- [ ] 原始用户音频默认不持久化、不进入日志和 TaskState。
- [ ] TTS 可以停止、重播，并能在用户打断时立即取消旧播报。
- [ ] 流式 ASR/TTS 失败时可回退批处理或文本输入。
- [ ] `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 和 `npm run test:e2e` 全部通过。
- [ ] 五分钟比赛演示中可以稳定展示一次语音 happy path 和一次噪声 fallback。
