# 本地语音唤醒重建：本地 KWS/VAD MVP

> 更新时间：2026-08-13。设计约束仍以 `docs/local-voice-rebuild.md` 为准。
> 注：本文提到的真浏览器探针使用可重复的假麦克风 WAV；真实设备验收仍未完成。

## 1. 边界

当前默认待机唤醒已从持续 Web Speech 改为本地 sherpa-onnx KWS，并用共享 16 kHz PCM 驱动 Silero VAD。命令识别优先走 `/v1/voice/stream` 双向 WebSocket，由服务端桥接豆包 SeedASR 2.0 `bigmodel_async`；流式链失败时用已有 `/v1/voice/transcribe` 批处理代理兜底，服务端完全未配置 ASR 时才回退到唤醒后的 Web Speech 兼容路径。

## 2. 文件

| 文件 | 职责 |
| --- | --- |
| `apps/demo/src/voice/audioCapture.ts` | 唯一 `getUserMedia` owner；AudioWorklet 采集；16 kHz mono 输出；epoch/资源回收 |
| `apps/demo/src/voice/pcmRing.ts` | 固定容量环形 PCM，`readLatest()` 返回拷贝，默认 1.5 秒 |
| `apps/demo/src/voice/pcmResampler.ts` | 线性重采样；`StreamingMonoResampler` 跨包相位正确 |
| `apps/demo/src/voice/localWakeRuntime.ts` | 可注入 `WakeDetector`；本地 wake 事件 seam；不内置模型、不发网络请求 |
| `apps/demo/src/voice/sherpaKwsDetector.ts` | 加载本地 WASM/model，运行时关键词 `x iǎo n án @小南` |
| `apps/demo/src/voice/sileroVadDetector.ts` | Silero VAD，512 samples/16 kHz，64 ms 起音、800 ms 静音尾 |
| `apps/demo/src/voice/localHandsFreeController.ts` | 把 KWS/VAD/命令 ASR 接入纯 hands-free FSM 和现有 Agent 输入链 |
| `apps/demo/src/voice/pcmCommandRecognizer.ts` | 共享 PCM16LE、预卷和服务端转写协议适配 |
| `apps/demo/src/voice/adaptiveCommandRecognizer.ts` | 按 `/v1/voice/capabilities` 选择 PCM ASR 或 Web Speech 回退 |
| `scripts/voice-*.{mjs,sh}` | 固定下载、SHA-256、KWS 构建、兼容补丁和资产探针 |

## 3. 关键决策

- **AudioWorklet-only 默认**：从内联 Blob 生成 `canvasflow-voice-capture` 处理器，主线程以零增益 `GainNode` 静音落点；不连接扬声器、不引入已弃用的 `ScriptProcessorNode`。实验性回退只在显式 `allowScriptProcessorFallback: true` 时可用。
- **epoch 护栏**：`disable()/dispose()` 会让迟到的 `getUserMedia`/worklet 消息立即失效并停轨；快速开关不会留下孤儿麦。
- **隐私**：唤醒前 PCM 只进 `PcmRing`/injected detector；本模块没有任何上行。
- **禁用即可见**：未注入 detector、worklet 不可用、权限拒绝都进入 `disabled/error` 状态，绝不显示假的“等待唤醒”。
- **有界预卷**：detector 加载/启动期间最多缓冲 64 帧，就绪后按序补推，减少唤醒词首字丢失；`preRoll` 从环形缓冲拷贝给上层。
- **生成资产**：模型与 WASM 不进 Git；运行前执行 `bash scripts/fetch-voice-models.sh` 和 `bash scripts/voice-build-kws-wasm.sh`。
- **真浏览器探针**：项目启动后执行 `npm run test:voice-wake`；Chromium 假麦克风播放 16 kHz “小南小南”后，UI 应从“点击启用”进入“正在聆听”，不是文本匹配模拟。

## 4. 下一步（尚未做）

1. 用 Mac 内置麦、AirPods 和有线耳机执行真麦 DoD，校准 score/threshold 与误唤醒率。
2. 配置 `DOUBAO_ASR_API_KEY` 并用内置麦/AirPods 验收同句“小南，查天气”的首字完整率；`DOUBAO_ASR_RESOURCE_ID` 默认使用 `volc.seedasr.sauc.duration`。
3. 把 VAD/KWS 推理进一步迁移到 Worker，并完成 TTS 打断与回声护栏真麦验收。

## 4. ASR 合同

`WS /v1/voice/stream` 先接收 `{ "type":"start", "generation":number }`，随后接收 PCM16LE 二进制帧，以 `{ "type":"stop" }` 结束；服务端向浏览器持续返回 `partial`，豆包最终确定稿以 `final` 返回。豆包 API Key 只存在服务端环境变量，不下发浏览器。`POST /v1/voice/transcribe` 继续作为批处理兜底，接收 `audio/pcm;format=s16le;rate=16000;channels=1`。`GET /v1/voice/capabilities` 返回 `{ "pcmAsr": boolean, "streamingAsr": boolean }`。
