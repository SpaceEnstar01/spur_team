# Spur 开发版独立语音智能体实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本任务按用户要求只暂存，不提交。

**Goal:** 在 Spur iOS Debug 中提供独立、美观、可从 Recordings 进入且可由戒指长按即时打开的语音智能体，支持对话、生图和预填目的地的高德打车。

**Architecture:** 以独立的 `src/voice-agent/` 模块持有任务、模型请求和外部操作；RN 页面仅订阅状态与收集输入。原生桥接负责长按事件、Debug Key 和打车 URI 校验；现有自动同步只增加一个“结果先交给新任务认领、再广播刷新”的接口。STT 与图片复用已上线服务；文字模型和高德 MCP 在 Debug 客户端调用。

**Tech Stack:** React Native 0.76 / Expo 52 / TypeScript、iOS Objective-C RingSDK 桥接、`react-native-sse`、`expo-av`、`expo-file-system`、Node 22 `--experimental-strip-types --test`。

**Spec:** [2026-10-08-spur-debug-voice-agent-design.md](../specs/2026-10-08-spur-debug-voice-agent-design.md)

## Global Constraints

- 只修改 Spur；不改 DreameRing；原有 AI Assistant、普通录音和 Release 行为保留。
- 新功能仅 iOS Debug：`#if DEBUG` 才导出本机密钥，Release 不显示入口、不自动导航。
- 密钥保存在 Git 忽略的本地文件；任何暂存内容、日志、测试均不得包含 Key；不提交、不推送。
- 戒指长按即时跳页；固件无触控事件时可用录音状态兜底，但新任务不得消费旧文件或普通长录音。
- 打车必须有明确目的地，生成并校验带目的地的高德打车 URI；失败显示错误，不能以未填目的地的页面冒充成功或宣称已下单。
- 页面跟随 `APP_LANGUAGE`；真图才能显示为生成结果；相同任务只能处理一次，旧 AI Assistant 不重复接收该录音。
- 保留当前工作区原有 `App.tsx`、`Podfile.lock`、`project.pbxproj`、`yarn.lock` 改动；只暂存本任务的文件/变更块。

## Review Focus

1. 同一次长按同时收到状态事件：只创建一个任务、导航一次（任务 2、3 的测试）。
2. 同步列表中混有旧文件或多条新文件：只匹配本次文件，未匹配明确失败（任务 2 的测试）。
3. 打车目的地缺失、坐标非法、MCP URI 被篡改：不调用 `openURL`（任务 4 的测试）。
4. STT、模型或图片接口超时/转后台：保留已完成阶段，取消当前请求并可单阶段重试（任务 2、4、5 的测试）。
5. Release 构建或本机 Key 缺失：没有新入口和后台触发，暂存区不含凭据（任务 1、6 的检查）。

---

### Task 1: Debug 原生能力与密钥边界

**Files:**
- Modify: `.gitignore`; `app/mobile/native-sdk/ios/YanqiangVoiceModule.m`; `app/mobile/src/native/YanqiangVoiceNative.ts`
- Create: `app/mobile/native-sdk/ios/SpurVoiceAgentSecrets.example.h`; `app/mobile/native-sdk/ios/SpurVoiceAgentSecrets.h`（本机、忽略、绝不暂存）；`app/mobile/tests/voice-agent/native-contract.test.mjs`

**Interfaces:**
- Produces: `YanqiangVoiceEventNames.touch` 的 `{ event: number, timestamp: number }`（毫秒）；`YanqiangVoiceNative.voiceAgentDebugConfig` 的 `{ enabled: boolean, siliconFlowApiKey: string, amapWebApiKey: string }`；`YanqiangVoiceNative.openAMapTaxiURI(uri): Promise<void>`。

- [ ] 写失败测试：源码契约确保 `0x0103` 事件、`#if DEBUG` 密钥门控和 Release 空值路径存在，且打车 URI 必须有唯一的 `dlon/dlat/dname`。
- [ ] 用 `node --experimental-strip-types --test app/mobile/tests/voice-agent/native-contract.test.mjs` 确认先失败。
- [ ] 接入 `touchReq.listeningTouchEvent`，仅在启用且连线时上报；实现原生打车 URI 白名单校验与打开；添加无密钥模板和忽略规则；以本地文件注入已有 DreameRing Debug Key，任何工具输出只报告“已配置/未配置”。
- [ ] 重跑测试，并在 `app/mobile` 依次运行 `xcodebuild -workspace ios/RecordingRing.xcworkspace -scheme RecordingRing -configuration Debug -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build` 和同命令的 `Release` 配置；检查 Release 无 Key 常量。
- [ ] 定向暂存模板、忽略规则和源码；`git check-ignore` 确认本机密钥文件被忽略。

### Task 2: 纯任务状态、关联与持久化

**Files:**
- Create: `app/mobile/src/voice-agent/voiceAgentTypes.ts`; `voiceAgentPolicy.ts`; `VoiceAgentController.ts`; `voiceAgentStorage.ts`; `app/mobile/tests/voice-agent/controller.test.mjs`; `policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 的事件形状。
- Produces: `createVoiceAgentController(deps): VoiceAgentController`，公开 `onRingTrigger(source, at)`, `onRecordingStatus(state, at)`, `onSyncedFiles(files)`, `submitText(text)`, `submitPhoneAudio(uri)`, `retry(taskId)`, `subscribe(listener)`, `getState()`；`isVoiceAgentOwnedFile(id): Promise<boolean>`；任务阶段 `recording | syncing | transcribing | responding | completed | failed | ordinary`。

- [ ] 写失败测试：触控/录音状态去重、后台不新建任务、仅新文件匹配、>15 秒兼容任务归属普通录音、队列串行、失败阶段重试、历史上限和持久化不含密钥。
- [ ] 运行 `node --experimental-strip-types --test app/mobile/tests/voice-agent/controller.test.mjs app/mobile/tests/voice-agent/policy.test.mjs` 确认先失败。
- [ ] 实现无 RN 依赖的状态/关联逻辑与依赖注入控制器；文件持久化适配层用 `expo-file-system`，记录认领文件 ID 并限量保留历史。
- [ ] 重跑测试，确认所有断言通过；定向暂存任务 2 文件。

### Task 3: 戒指同步事件接入与旧卡片隔离

**Files:**
- Create: `app/mobile/src/voice-agent/voiceAgentRuntime.ts`; `app/mobile/src/navigation/voiceAgentNavigation.ts`; `app/mobile/tests/voice-agent/runtime.test.mjs`
- Modify: `app/mobile/src/services/autoSyncRecordings.ts`; `app/mobile/src/services/localAgentCards.ts`; `app/mobile/App.tsx`

**Interfaces:**
- Consumes: Task 2 控制器；现有 `AUTO_SYNC_COMPLETE_EVENT`、`listLocalAudioFiles()`。
- Produces: `startVoiceAgentRuntime()`，幂等注册触控、状态和同步观察者；`voiceAgentNavigationRef` 供前台即时跳转。

- [ ] 写失败测试：重复 BLE 事件只导航一次；未启用 Debug 不订阅；自动同步先认领新文件再广播；已认领短音频不进入旧 `syncLocalAgentCards()`，普通短音频仍进入。
- [ ] 跑 `node --experimental-strip-types --test app/mobile/tests/voice-agent/runtime.test.mjs` 确认先失败。
- [ ] 仅扩展现有同步完成路径与旧卡片过滤，使用控制器运行时注册；在 `App.tsx` 挂导航 ref/启动服务，保留原有 GestureHandler 修复。
- [ ] 重跑测试并检查 `git diff -- app/mobile/App.tsx`；仅暂存本任务新增变更块，不暂存此前的 App.tsx 改动或其他已有脏文件。

### Task 4: 独立模型、图片与高德操作

**Files:**
- Create: `app/mobile/src/voice-agent/VoiceAgentAIClient.ts`; `VoiceAgentImageService.ts`; `VoiceAgentAMapClient.ts`; `VoiceAgentRideService.ts`; `voiceAgentRouter.ts`; `app/mobile/tests/voice-agent/ai-client.test.mjs`; `router.test.mjs`; `ride.test.mjs`
- Modify: `app/mobile/package.json`; `app/mobile/package-lock.json`

**Interfaces:**
- Consumes: Task 1 Debug config/open URI；现有 `AUDIO_AGENT_BASE_URL` 与图片路由。
- Produces: `askVoiceAgent(prompt, handlers): { cancel(): void }`（SSE 分块）；`generateVoiceAgentImage(prompt): Promise<{ output: string; imageUrl: string }>`；`extractRideDestination(prompt): string | undefined`；`openRideDestination(destination): Promise<void>`；`routeVoiceAgentPrompt(prompt): 'ride' | 'image' | 'chat'`。

- [ ] 写失败测试：Ling Flash SSE 的分块/结束/取消/错误；图片只请求现有 `/api/assistant/skill-refine` 且必须返回 URL；目的地解析、坐标/URI 校验、MCP 错误与空目的地均不打开外部 App；普通天气问题不进入打车或生图。
- [ ] 跑 `node --experimental-strip-types --test app/mobile/tests/voice-agent/ai-client.test.mjs app/mobile/tests/voice-agent/router.test.mjs app/mobile/tests/voice-agent/ride.test.mjs` 确认先失败。
- [ ] 移植 DreameRing 的 Ling Flash SSE 与高德 MCP 思路为 Spur 独立服务，安装并锁定 `react-native-sse`；通过依赖注入隔离网络/原生调用；不得把 Key 写入 JS 源码或测试。
- [ ] 重跑上述三组测试；用 Debug 真机请求分别确认普通回复、图片返回和带目的地打车 URI；定向暂存任务 4 文件。

### Task 5: 手机语音输入与独立对话页

**Files:**
- Create: `app/mobile/src/voice-agent/phoneVoiceInput.ts`; `app/mobile/src/screens/voice-agent/VoiceAgentScreen.tsx`; `app/mobile/src/screens/voice-agent/VoiceAgentComposer.tsx`; `app/mobile/src/screens/voice-agent/VoiceAgentResultCard.tsx`; `app/mobile/tests/voice-agent/phone-input.test.mjs`
- Modify: `app/mobile/src/navigation/AppNavigator.tsx`; `app/mobile/src/types/navigation.ts`; `app/mobile/src/screens/recordings/RecordingListScreen.tsx`; `app/mobile/src/locales/en.ts`; `app/mobile/src/locales/zh.ts`

**Interfaces:**
- Consumes: Task 2 控制器/状态，Task 3 导航 ref，Task 4 请求路由；现有 `captureVoiceIntent()`。
- Produces: `VoiceAgent` Stack route、Recordings Debug AI 按钮、可进入的对话/录音/图片/打车页面。

- [ ] 写失败测试：手机麦克风权限拒绝、空转写、取消录音、成功转写文本进入新控制器；新页面仅 Debug 展示入口的静态/渲染检查。
- [ ] 跑 `node --experimental-strip-types --test app/mobile/tests/voice-agent/phone-input.test.mjs` 确认先失败。
- [ ] 用现有 `expo-av` 和转写接口封装手机输入；实现卡片式自适应页面、键盘/安全区、加载/错误/重试/清空确认、中英文文案；只对明确的真实结果显示图片或打车动作。
- [ ] 重跑上述测试，并在 `app/mobile` 运行 `./node_modules/.bin/tsc --noEmit --module esnext`；检查小屏和当前 iPhone 的布局与可点区域；定向暂存任务 5 文件。

### Task 6: 集成验证与交付

**Files:**
- Modify: 仅前面任务发现缺陷的文件；更新本计划复选框/验证记录。

**Interfaces:** 完整端到端 Debug 体验。

- [ ] 运行全部 `node --experimental-strip-types --test app/mobile/tests/voice-agent/*.test.mjs`、TypeScript 检查、`git diff --check` 和 iOS Debug/Release 编译。
- [ ] 真机验证：Recordings 手动入口；长按即时导航；无触控固件状态兜底；戒指同步、转写、回复；手机文字/语音；图片；“帮我打车去虹桥机场”打开高德且目的地已填；普通长录音不调用新模型。
- [ ] 验证 Release 无入口/密钥；检查忽略文件和 `git diff --cached` 不含密钥，旧 AI Assistant 行为不变。
- [ ] 只将任务代码与文档留在暂存区，保留原有未暂存改动；不提交、不推送。无法实测的硬件或第三方行为在交付时如实说明。

## 验证记录（2026-10-09）

- 纯逻辑测试：17/17 通过，含戒指/文字并发、重复触控、旧录音排除、目的地与坐标校验、恢复可重试状态。
- TypeScript：`tsc --noEmit --module esnext` 通过；Expo iOS 导出通过。
- iOS Debug/Release 无签名编译通过；Release 二进制检查未包含本地 Debug 密钥。签名 Debug 已安装并启动于 iPhone 15 Plus，Expo 隧道成功下发更新的 JS 包。
- Ling Flash 请求及高德 MCP 打车 URI 已分别完成在线调用；真机上的戒指长按、图片展示和高德 App 跳转仍待人工端到端确认。测试手机当时未安装高德地图。
- 代码审查提出的重要边界问题已修正；原工作区已有改动需继续保持在暂存区之外。本计划所列文件拆分/测试文件名与实际实现有差异，以最终暂存文件和上述验证命令为准。

## 2026-10-09 戒指第二次录音排查

- 真机任务记录显示第二、第三次戒指任务一直处于 `syncing`；手机上对应文件已存在，但文件名的录制时间分别为 03:37:10、03:37:35 UTC，转换后的修改时间却是 03:40:20、03:40:22 UTC。旧匹配逻辑误用修改时间，导致第二段被 03:39:17 的后续任务认领。
- Metro 日志还显示一次同步长期占锁，期间多次录音结束同步被跳过，约三分钟后才恢复；因此缩短“无传输进展”的重试等待，同时保留持续有进展的传输。
- 新增实际时间线的回归测试、旧任务误认领恢复测试及同步看门狗测试；本机文件内容和密钥不写入仓库。真机自动恢复及再次戒指录音仍需观察。
- 用手机导出的任务元数据和文件元数据（不读取音频内容）离线重放，新逻辑按顺序把 03:37:10、03:37:35、03:39:16 三个文件分配给对应三次戒指任务；旧的错误认领被纠正。签名 Debug 构建已重新安装，设备内自动恢复需确认开发服务页面已进入应用。
