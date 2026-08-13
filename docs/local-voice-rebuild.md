# CanvasFlow 本地语音唤醒重建方案

> 状态：设计稿，暂不改动现有语音实现。目标是把当前“浏览器识别结果里找唤醒词”升级为“本地声学唤醒 + 本地 VAD + 唤醒后识别”。
> 约束：保留文字输入、点击/按住录音和 Fixture 回放；任何语音输入仍只通过既有 Agent API、注册 Action、Confirmation 入口产生业务副作用。

## 1. 先定结论

当前 `packages/voice/src/wake-word.ts` 匹配的是 `SpeechRecognition` 返回的文本，`packages/voice/src/speech.ts` 同时承担持续唤醒和命令转写。这不是声学唤醒，不能作为产品级 hands-free 基础：

- 识别服务由浏览器/厂商控制，`onend`、权限、网络或限流会让“等待唤醒”变成假活跃；应用无法可靠恢复或判断音频是否已上传。
- `SpeechRecognition` 不能接收我们自己的 PCM 流，无法共用 AudioWorklet、VAD、前滚缓冲，也无法保证“一句唤醒词 + 命令”的首字不丢。
- 唤醒词只能在文本层做前缀匹配；`小南`、`小楠`、`xiaon` 等变体会随浏览器 ASR 漂移，漏唤醒和误唤醒不可用同一套阈值治理。
- 唤醒前原始音频可能进入浏览器语音服务，和“唤醒前音频不出浏览器”的隐私目标冲突。

因此：

1. Web Speech 保留为显式、兼容性回退，不再宣称它提供本地唤醒。
2. 新链路以 `WakeEngine`、`VadEngine`、`CommandRecognizer` 三个可替换接口接入纯逻辑状态机。
3. MVP 可以暂时采用“两段式”：本地唤醒后再启动 Web Speech；产品版必须改为同一条 PCM 链路上的流式 ASR。

## 2. 目标数据流

```text
getUserMedia（唯一 owner；AEC/NS/AGC）
        |
        v
AudioWorklet：实际采样率 -> 16 kHz、mono、Float32/512 samples
        |
        +--> Worker：KWS（常驻，只输出 wake）
        +--> Worker：VAD（speech-start / speech-end）
        +--> PcmRing：保留最近 1.5 s，唤醒前只在本机内存
                         |
              wake 后打开上行门
                         v
              CommandRecognizer（产品版 PCM16LE WS）
                         |
                 partial / final / error
                         v
             VoiceLoop -> FIFO -> Agent / Action / Confirmation
                         |
                         v
                    TTS / barge-in
```

唤醒前不得创建 ASR 上行会话，也不得发送 PCM、WAV、WebM 或转写文本以外的隐私音频。KWS 命中只产生事件，不解释业务、不直接改 `TaskState`。

### 唤醒词资产

模型词表核验以 `tokens.txt` 为准，不依赖中文到拼音的运行时猜测。`小南` 的明确 token 串是：

```text
x iǎo n án
```

若产品词是“小南小南”，运行时配置应明确写成：

```text
x iǎo n án x iǎo n án @小南小南
```

构建/探针必须检查每个 token 都存在；任一 OOV 时禁用该预设并给出可见提示，不能静默失效。

## 3. 状态机与安全边界

状态机保持纯逻辑、可注入时钟和效果，不依赖 DOM、WASM 或具体 ASR：

```text
NEEDS_AUTH --授权成功--> ARMED --wake--> LISTENING
ARMED --点击/Fixture--> LISTENING
LISTENING --speech-end + final--> THINKING
THINKING --tts-start--> SPEAKING
THINKING --error/无播报/超时--> FOLLOW_UP
SPEAKING --tts-end--> FOLLOW_UP
SPEAKING --VAD >= 300 ms 或明确 wake--> LISTENING（先停播）
FOLLOW_UP --speech-start--> LISTENING
FOLLOW_UP --超时（默认 8 s）--> ARMED
LISTENING --5 s 无开口--> ARMED（静默回收，不发请求）
任意状态 --关闭/资源错误--> IDLE 或 NEEDS_AUTH
```

必须保留以下护栏：

- `epoch`/生命周期代号：快速开关、React StrictMode 或卸载不能留下孤儿麦克风、AudioContext、Worker。
- `asrGeneration`：旧 ASR 的迟到 `partial/final/error` 一律丢弃，不能劫杀下一轮。
- 单一 `final` 守卫、FIFO 命令队列和失败原话回填；每条文本必须“发送、排队或回填”三者之一。
- `pendingConfirmation` 存在时，“取消/不要/确认”等短句必须走 `api.confirmation`；本地 dismiss 不能吞掉安全确认。
- 普通语音只调用 `sendInput`；注册 Action 和危险操作沿现有 `api.action`/`api.confirmation`，语音层不直接写业务状态。

## 4. MVP 与产品版的边界

| 能力 | MVP（止血，可先合入） | 产品版（目标） |
|---|---|---|
| 唤醒 | 本地 KWS + 本地 VAD | 同左，AudioWorklet -> Worker |
| 命令识别 | 唤醒后重新启动 Web Speech | 唤醒后打开 PCM16LE 流式 ASR |
| 说法限制 | **必须分两段**：“小南”停顿后再说命令；不承诺“小南，查天气”一口气可靠 | 支持一口气说完，VAD 端点自动定稿 |
| 首字保护 | 不取唤醒前音频；首字可能受 Web Speech 启动延迟影响 | wake 路径 `preRoll=0`；续问/barge-in 取 200 ms + 判定延迟，最多 1.2 s |
| 上行隐私 | 唤醒前无 ASR；唤醒后由浏览器 Web Speech 接管 | 唤醒前无上行；唤醒后仅上传 PCM16LE 音频 |
| 失败回退 | Web Speech 失败回到可点击/文字路径 | 流式失败用已缓存 PCM 封 WAV 调 `/api/asr`，原话回填 |

MVP 的 UI 必须明确显示“两段式实验能力”，不能让用户以为它已支持产品版连续命令。产品版上线前应移除该限制文案，并完成真麦 DoD。

## 5. 模块与接口

建议新增或替换以下模块；现有 `wake-session` 继续负责授权、重试和 UI 语义，不能把权限逻辑塞进声学引擎。

### 建议接口

```ts
export type AudioFrame = {
  samples: Float32Array       // 16 kHz mono；固定 512 samples
  sampleRate: 16000
  seq: number                 // 严格递增，便于丢帧检测
}

export type WakeEngine = {
  load(): Promise<void>
  start(onWake: (keyword: string) => void, stream: MediaStream): Promise<void>
  stop(): void
  setKeywords(tokens: string): void
}

export type VadEngine = {
  load(): Promise<void>
  start(callbacks: {
    onFrame(frame: AudioFrame): void
    onSpeechStart(): void
    onSpeechEnd(): void
    onError(error: Error): void
  }, stream: MediaStream): Promise<void>
  stop(): void
}

export type CommandRecognizer = {
  start(options: {
    language: string
    provider: string
    model: string
    silenceMs: number
    preRoll: Float32Array
  }): Promise<void>
  pushFrame(frame: AudioFrame): void
  stop(): void
  abort(): void
}
```

实现分层：

- `audio-capture.worklet.js`：只采集和分帧；读取实际 `AudioContext.sampleRate`，必要时重采样到 16 kHz。使用 transferable `ArrayBuffer` 或预分配缓冲，不在主线程做音频拷贝循环。
- `voice-worker.ts`：封装 KWS/VAD 推理和有界消息协议；帧序断裂、推理异常、模型缺失都发结构化错误。
- `kws-engine.ts` / `vad-engine.ts`：只翻译 Worker 消息，不知道 Agent 业务。
- `pcm-ring.ts`：固定容量、复制入环、按毫秒取尾；唤醒前只供本地首字保护和调试指标。
- `command-recognizer.ts`：PCM16LE 约 100 ms 聚包，处理 `start/stop/partial/final/done/error`，单 final 和 generation 守卫。
- `hands-free-controller.ts`：拥有唯一 `MediaStream`，负责 enable/disable、资源回收、FSM 效果和回退。
- `voice-loop.ts`：纯状态机；继续复用现有 `packages/voice/src/machine.ts` 的测试风格，不直接依赖 React。

**明确不照抄上游实现**：不使用已弃用的 `ScriptProcessorNode`，不让 KWS decode 或 ORT VAD 在主线程串行推理，不把音频节点连接到 `destination` 只为维持回调。AudioWorklet + Worker 是本方案的硬要求；低端浏览器不满足时应禁用本地链路并保留文字/点击回退。

## 6. PR 拆分

按可回滚、每个 PR 可独立验证拆分：

1. **PR-0：探针与契约（无产品开关）**
   - 验证 `x iǎo n án` 在目标 KWS `tokens.txt` 中无 OOV。
   - 加 `AudioFrame`、Worker 消息、`WakeEngine/VadEngine/CommandRecognizer` 类型和纯逻辑测试。
   - 输出模型大小、加载耗时、CPU、`crossOriginIsolated` 和真实采样率报告。
2. **PR-1：AudioWorklet + 本地 KWS/VAD**
   - 单路麦 owner、Worker 推理、`PcmRing`、模型缺失自动禁用。
   - 默认 feature flag 关闭；文字、点击录音、Fixture 全部不受影响。
3. **PR-2：MVP 两段式接线**
   - KWS 命中后进入现有 `wake-session`/VoiceLoop，再启动 Web Speech 命令识别。
   - 明示“两段式”限制；补权限拒绝、`onend`、重启失败和队列回填测试。
4. **PR-3：PCM ASR 协议与产品链路**
   - 新增 `/api/asr/stream` PCM16LE `start/stop` 契约及服务端批处理 WAV 回退。
   - 接入 wake/follow-up/barge-in pre-roll、partial/final、静音尾和断线恢复。
5. **PR-4：上线硬化与验收**
   - 生产 headers、模型清单/哈希、第三方许可、观测指标、真麦验收脚本和回滚开关。
   - 仅当 DoD 全部通过后打开默认值；否则保留旧路径。

## 7. 模型、headers、许可证与资产

### 资产布局与脚本

建议统一落在应用静态目录，二进制不进 Git：

```text
apps/demo/public/voice/kws/
  sherpa-onnx-kws.js
  sherpa-onnx-wasm-kws-main.js
  sherpa-onnx-wasm-kws-main.wasm
  sherpa-onnx-wasm-kws-main.data
apps/demo/public/voice/models/silero_vad.onnx
scripts/fetch-voice-models.sh
scripts/build-kws-wasm.sh
scripts/voice-assets-manifest.json
```

脚本要求：固定上游仓库、release/tag、构建工具版本和下载 URL；支持断点续传；下载后强制 SHA-256 校验；输出 manifest（文件、大小、来源、SHA-256、许可证）；缺失或校验失败时返回非零并让运行时进入可见 disabled 状态。`.gitignore` 只忽略二进制，保留 `.gitkeep`、脚本和 manifest 模板。

KWS 运行时可参考 `SuperdeMan/cockpit-agent` 的构建思路，但不得假设其默认输出目录正确：上游脚本默认探针路径，而运行时代码使用 `/kws/`，移植时必须统一路径并在构建产物中做 smoke check。

### headers 与浏览器约束

若使用 pthread KWS WASM，开发服务器、`vite preview`、Node 静态服务器和反向代理都必须发送：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

启动探针必须断言 `crossOriginIsolated === true`；若不能满足，选择非 pthread 构建或关闭 KWS，不能半初始化。`credentialless` 仍需回归 AMap、跨源图片、API、SSE/WS 和生产 CSP。单线程 `onnxruntime-web/wasm` 的 VAD 不依赖 `SharedArrayBuffer`，但不应因此省略 KWS 的隔离检查。麦克风和 AudioWorklet 仍要求 `localhost` 或 HTTPS、用户授权和前台页面。

### 许可证

CanvasFlow 当前没有根许可证。引入模型/运行时前必须在 `THIRD-PARTY-NOTICES.md` 增加逐项记录：sherpa-onnx 源码、KWS 模型/WenetSpeech 资产、Silero VAD 模型、`onnxruntime-web`、构建产物和下载来源。上游仓库声明 Apache-2.0、ORT 为 MIT，但模型和生成二进制仍需按其实际发布页核验；不能只复制上游仓库的 LICENSE。若采用上游代码片段，保留归属、修改声明和许可证义务；优先重写接口与实现，避免复制 `ScriptProcessor`/主线程推理代码。

## 8. 真麦 DoD（未通过不得宣称“唤醒正常”）

测试设备至少包括 Mac 内置麦、AirPods/蓝牙麦和一副有线耳机；Chrome/Edge 各测一次；安静、车辆/风噪、音乐、TTS 回声四种环境分别记录原始结果。

- **命中率**：安静环境 20 次至少 19 次；中等背景噪声 20 次至少 18 次；每次记录距离、角度、设备和音量。
- **误唤醒**：背景音乐/播报连续 30 分钟最多 1 次；TTS 念到“小南”时不得自唤醒。
- **隐私**：唤醒前 DevTools Network 无 PCM/WAV/WebM/ASR 请求；只允许本地模型资源请求。
- **时延**：wake 到 `LISTENING` p95 ≤500 ms；speech-start 判定 ≤150 ms；800 ms 配置下 speech-end 尾部 600–900 ms。
- **首字与完整句**：产品 PCM ASR 一口气说“小南，查杭州天气”，首字丢失率 <5%；流式失败时 WAV 回退不静默丢句。
- **状态与资源**：连续 30 分钟无重复 listener、无多余 `MediaStreamTrack`/AudioContext/Worker；快速开关和旧回调不影响新轮。
- **业务安全**：普通命令仍到 Agent；注册 Action 和 Confirmation 仍走原 API；确认挂起时说“取消”不会被本地 dismiss 吞掉。
- **降级**：无权限、模型缺失、COOP/COEP 不满足、Worker 崩溃、ASR 断网时，UI 可见提示且文字/点击/Fixture 可继续；不得留下“等待唤醒”假状态。

## 9. 参考实现与迁移边界

上游参考（只读研究，当前 HEAD `2b01ec0`）：

- [kwsEngine.ts](https://github.com/SuperdeMan/cockpit-agent/blob/2b01ec0857f41265e3ebaeacd7891839bf4671d5/hmi/src/kwsEngine.ts)
- [vadEngine.ts](https://github.com/SuperdeMan/cockpit-agent/blob/2b01ec0857f41265e3ebaeacd7891839bf4671d5/hmi/src/vadEngine.ts)
- [handsFreeController.ts](https://github.com/SuperdeMan/cockpit-agent/blob/2b01ec0857f41265e3ebaeacd7891839bf4671d5/hmi/src/handsFreeController.ts)
- [AudioWorklet](https://github.com/SuperdeMan/cockpit-agent/blob/2b01ec0857f41265e3ebaeacd7891839bf4671d5/hmi/public/vad-capture-worklet.js)
- [设计卡](https://github.com/SuperdeMan/cockpit-agent/blob/2b01ec0857f41265e3ebaeacd7891839bf4671d5/docs/design/2026-07-04-r4.3-wake-vad-fullduplex.md)

可复用的是边界、生命周期护栏、单路 PCM、VAD 端点和前滚策略；不可照搬的是 `ScriptProcessorNode`、主线程推理、独立多路麦克风和未固定的模型输出路径。任何实现 PR 都应先更新本方案对应章节，再提交代码与测试。
