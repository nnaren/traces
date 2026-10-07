# Agent 轨迹数据源与格式参考

> 用途：为「Codex / Claude Code 轨迹可视化工具」提供数据来源、存储布局与字段级格式说明。
> 证据基线：`deepseek-harness` 当前 checkout（2026-10-07）+ 本机 `~/.codex`、`~/.claude` 实际采样。
> 标注约定：**[实测]** = 从本机真实文件采样得到；**[代码]** = 仓库源码明确；**[推断]** = 交叉推导，未显式断言。

---

## 0. 结论摘要

做一个轨迹可视化工具，有三条可选数据源：

| 方案 | 数据源 | 保真度 | 覆盖 | 采集难度 | 建议 |
|---|---|---|---|---|---|
| **A** | Codex 原生 rollout JSONL（磁盘 tail） | 高 | prompt / 工具调用 / 结果 / reasoning 占位 / usage / TTFT / turn 时长 | 低（读文件） | ✅ **推荐主源** |
| **B** | Claude Code 原生 JSONL（磁盘 tail） | **最高**（thinking 明文、usage 逐条、cost、tool 时间） | prompt / thinking / 工具 / 结果 / usage / cost / turn 时长 | 低（读文件） | ✅ **推荐主源** |
| **C** | DSH 自身 session log（JSONL.zstd 或导出 ZIP） | 高，且设计最规整 | 57 种事件，含 token 级时间戳 | 中（需解 zstd 帧串联） | 备选 / 格式参考 |
| D | Codex `app-server --stdio` JSON-RPC | 高，实时 | 同 A 但可实时旁路 | 中（需实现 JSON-RPC 客户端） | 需要实时性时用 |
| E | Claude Agent SDK message 流 | 高，实时 | 同 B | 中（需嵌 SDK） | 需要实时性时用 |

**关键判断：**
- **Codex 的 reasoning 内容是加密的**（`encrypted_content`，Fernet/base64），**无法展示思维链**，只能展示 `summary` 数组（实测常为空）。
- **Claude Code 的 thinking 是明文**（`content[].thinking` + `signature`），可展示。
- **两边都没有「step」这个显式概念。** DSH 有（`step/start`、`step/end`），Codex/Claude 都得靠 turn 内的工具调用边界自己推断。
- **DSH 不提供任何外部 CLI 会话的导入通道** **[代码]**，所以本工具必须自己解析 A/B 的原生文件。

---

## 1. 方案 A：Codex 原生 rollout JSONL

### 1.1 存储布局

```
~/.codex/
├── sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuidv7>.jsonl    # 活跃/近期会话
├── archived_sessions/rollout-<ISO8601>-<uuidv7>.jsonl       # 已归档会话
├── session_index.jsonl                                      # 轻量索引：会话名
├── history.jsonl                                            # CLI 输入历史（非轨迹）
└── .codex-global-state.json
```

- **一个会话一个文件**，追加写，纯 JSONL，**无压缩**。
- 文件名内嵌起始时间戳与 sessionId（uuidv7，时间有序）。
- `session_index.jsonl` 每行：`{"id":"<uuid>","thread_name":"...","updated_at":"<ISO>"}` **[实测]** — 可用于快速列出会话但**不含任何轨迹内容**。
- ⚠️ `archived_sessions/` 里的文件名日期与 payload 内 `session_meta.timestamp` 可能差一天（时区/归档动作造成），以 payload 为准。

### 1.2 行信封

**[实测]** 每行统一为：

```jsonc
{
  "timestamp": "2026-07-31T16:43:09.755Z",  // ISO8601 UTC，毫秒
  "ordinal": 2,                              // 会话内单调递增序号，从 0 起
  "type": "response_item",                   // 顶层分类
  "payload": { /* 随 type 变化 */ }
}
```

顶层 `type` 只有 6 种（实测全量采样）：

| type | 语义 | 是否内容 |
|---|---|---|
| `session_meta` | 会话建立，一次 | 元信息 |
| `turn_context` | 每个 turn 一次 | cwd / 权限 / 模型 |
| `response_item` | **模型对话流的主干**，每 item 一行 | ✅ 核心 |
| `event_msg` | **给 UI 的旁路事件**，与 response_item 并行 | ✅ 指标来源 |
| `world_state` | 环境快照（AGENTS.md 等） | 上下文 |
| `inter_agent_communication_metadata` | 多 agent 元数据 | 元信息 |

> **这是 Codex 格式最重要的一个坑：数据是双层的。** `response_item` 是"发给模型的对话"，`event_msg` 是"给 UI 的通知"。**两者内容大量重复，但 usage / timing 只在 `event_msg` 里。** 只读一层会丢一半信息。

### 1.3 `response_item` 子类型

**[实测]** 全量采样得到的 `payload.type` 分布：

| payload.type | 关键字段 | 说明 |
|---|---|---|
| `message` | `id`, `role`(developer/user/assistant), `content[]` | `content` 元素 `{type:'input_text'|'output_text', text}` |
| `reasoning` | `id`, `summary[]`, `content`(null), `encrypted_content` | ⚠️ **加密** |
| `function_call` | `id`, `name`, `namespace`, `arguments`(JSON字符串) | 标准函数工具 |
| `function_call_output` | `id`, `call_id`, `output`(任意JSON) | 配对用 `call_id` |
| `custom_tool_call` | `id`, `status`, `call_id`, `name`, `input`(字符串) | **自定义工具，input 是源码文本**（如 JS） |
| `custom_tool_call_output` | `id`, `call_id`, `output[]` | `output` 元素 `{type:'input_text', text}` |
| `agent_message` | `id`, `author`, `recipient`, `content[]` | 多 agent 消息 |

**示例（function_call）**：
```jsonc
{ "type": "response_item", "ordinal": 28, "payload": {
    "type": "function_call",
    "id": "fc_07b25575b77810...",
    "name": "spawn_agent",
    "namespace": "collaboration",
    "arguments": "{\"task_name\":\"task1_review_probe\",\"model\":\"gpt-5.6-terra\"}"
}}
```

**示例（custom_tool_call）** — 注意 `input` 是 **JS 源码字符串**，不是 JSON：
```jsonc
{ "type": "response_item", "ordinal": 12, "payload": {
    "type": "custom_tool_call",
    "id": "ctc_07b25575b7781...",
    "status": "completed",
    "call_id": "call_DpBpvbHeXbUBDOKJqekWKvY9",
    "name": "exec",
    "input": "const r = await tools.exec_command({\"cmd\":\"...\"});"
}}
```

**reasoning 的加密**：
```jsonc
{ "type": "response_item", "ordinal": 15, "payload": {
    "type": "reasoning",
    "id": "rs_07b25575b77810...",
    "summary": [],                              // 实测常为空数组
    "content": null,
    "encrypted_content": "gAAAAABqbNej2MHrs..."  // base64，无法解密
}}
```
👉 **可视化工具对 Codex 只能展示"存在 reasoning 块 + 字节数 + 时长"，不能展示内容。**

### 1.4 `event_msg` 子类型（指标来源）

**[实测]**：

| payload.type | 关键字段 | 用途 |
|---|---|---|
| `task_started` | `turn_id`, `started_at`(unix秒), `model_context_window`, `collaboration_mode_kind` | **turn 开始** |
| `task_complete` | `turn_id`, `last_agent_message`, `started_at`, `completed_at`, **`duration_ms`**, **`time_to_first_token_ms`** | ⭐ **TTFT + turn 时长** |
| `turn_aborted` | `turn_id`, `reason`("interrupted"), `started_at`, `completed_at`, `duration_ms` | 中断 turn |
| `token_count` | `info.total_token_usage`, `info.last_token_usage`, `model_context_window`, `rate_limits` | ⭐ **token 计量** |
| `item_completed` | `thread_id`, `turn_id`, `item{...}`, `completed_at_ms` | 单 item 完成时刻 |
| `thread_settings_applied` | `thread_settings{model, model_provider_id, service_tier, approval_policy, permission_profile}` | 模型切换 |
| `thread_goal_updated` | — | goal 变更 |

**`token_count` 完整结构** **[实测]**：
```jsonc
{ "type": "event_msg", "payload": {
  "type": "token_count",
  "info": {
    "total_token_usage": {                 // 会话累计
      "input_tokens": 26766, "cached_input_tokens": 8960,
      "cache_write_input_tokens": 0, "output_tokens": 182,
      "reasoning_output_tokens": 32, "total_tokens": 26948
    },
    "last_token_usage": { /* 同结构，本次增量 */ },
    "model_context_window": 258400
  },
  "rate_limits": { "limit_id": "codex", "primary": null, "secondary": null, "plan_type": null }
}}
```
⚠️ **`cached_input_tokens` 是 input 的子集还是独立计数，实测无法确定。** Codex 侧保守做法：`effective_input = input_tokens`（`input_tokens` 已含 cached，见 DSH 侧同名语义），展示时把 cached 单列一栏并注明口径不保证。

**`task_complete` 完整结构** **[实测]**：
```jsonc
{ "type": "event_msg", "ordinal": 71, "payload": {
    "type": "task_complete",
    "turn_id": "019fb90e-e81b-7861-9ef2-102f5867eff3",
    "last_agent_message": "...",
    "started_at": 1785516189,        // unix 秒
    "completed_at": 1785516302,
    "duration_ms": 112826,
    "time_to_first_token_ms": 3944   // ⭐ TTFT
}}
```

### 1.5 turn / step 的还原

- **turn**：每个 turn 有 `turn_id`（uuidv7）。出现位置：
  - `event_msg.task_started / task_complete / turn_aborted / item_completed` → `payload.turn_id`
  - `turn_context` → `payload.turn_id`
  - **`response_item` → `payload.internal_chat_message_metadata_passthrough.turn_id`**（部分 item 才有）**[实测]**
- **还原算法** **[推断，但可靠]**：按 `ordinal` 扫描；遇到带 `turn_id` 的记录就切换"当前 turn"；不带 `turn_id` 的 `response_item` 归属于当前 turn。文件开头第一个 `turn_context` 之前的内容属于 seed/meta。
- **step**：**Codex 没有 step 概念**。建议按工具调用边界自行推断：
  - 一个 assistant `message`（role=assistant）与其后连续的 `function_call`/`custom_tool_call` 序列构成一个 **step**
  - 或：每个 `function_call` + 其 `*_output` 配对即一个 step
  - 参考 DSH 的语义（`step/start`/`step/end` 包裹一次模型请求+工具循环）

### 1.6 工具调用配对

- `function_call.id` ↔ `function_call_output.call_id`（**用 `call_id` 配对，不是 `id`**）
- `custom_tool_call.call_id` ↔ `custom_tool_call_output.call_id`
- ⚠️ 存在**孤儿 call**（只有 call 没有 output，如进程被杀）与**孤儿 output**（测试数据里 `function_call_output.call_id` 与前面的 call 对不上 **[实测]**）。容错：按 `call_id` 建 map，缺失时标 `unresolved`。

### 1.7 其他 payload 形状

```jsonc
// session_meta（一次）
{ "session_id", "id", "timestamp", "cwd", "originator": "codex_work_desktop",
  "cli_version": "0.146.0-alpha.3.1", "source": "vscode", "thread_source": "user",
  "model_provider": "custom", "base_instructions": {"text": "..."} }

// turn_context（每 turn）
{ "turn_id", "cwd", "workspace_roots", "current_date", "timezone",
  "approval_policy", "approvals_reviewer",
  "sandbox_policy": {"type":"workspace-write","writable_roots":[...],"network_access":false},
  "permission_profile": {...}, "effort", "model" }

// world_state
{ "full": true, "state": {"agents_md": {"directory":"...","text":"..."} } }
```

### 1.8 Codex 侧的已知缺口

| 想要 | Codex 有吗 |
|---|---|
| 思维链文本 | ❌ 加密 |
| 逐工具耗时 | ❌ 只有 `item_completed.completed_at_ms`，无 duration |
| 逐请求 token | ⚠️ 只有 `last_token_usage`（可能跨多 item 聚合），无 request 级 |
| 流式 token 时间戳 | ❌ 日志里不落 delta |
| 子 agent 归属 | ⚠️ `agent_message.author/recipient` 有，但无结构化 parent-child |

---

## 2. 方案 B：Claude Code 原生 JSONL

### 2.1 存储布局

```
~/.claude/
├── projects/<cwd-slug>/<session-uuid>.jsonl    # 轨迹主体
├── projects/<cwd-slug>/agent-<subagent-uuid>.jsonl  # 子 agent（若有）
├── history.jsonl                               # 输入历史
├── .session-stats.json
└── telemetry/
```

**cwd slug 规则** **[实测]**：`/Users/yuanye/CODE/Harness/oh-my-claudecode` → `-Users-yuanye-CODE-Harness-oh-my-claudecode`
即：前导 `/` 变 `-`，其余 `/` 变 `-`，保留大小写与连字符。**逆推 cwd 时把 `-` 还原成 `/` 会失真（真实路径里的 `-` 无法区分）**，所以**以记录内的 `cwd` 字段为准，slug 只用来定位目录**。

- 一个会话一个文件，追加写，纯 JSONL，**无压缩**。
- 无独立索引文件；会话列表靠扫目录 + 读首行。

### 2.2 行信封

**[实测]** 没有 `ordinal`，**靠 `uuid` / `parentUuid` 构成一棵树**：

```jsonc
{
  "parentUuid": "94189874-...",     // 父节点 uuid，首条为 null
  "uuid": "7eba8449-...",           // 本节点 uuid
  "isSidechain": false,             // true = 子 agent（Task 工具派生）
  "timestamp": "2026-08-30T14:09:57.191Z",
  "sessionId": "98c08cba-...",
  "version": "2.1.250",             // CLI 版本
  "cwd": "/Users/yuanye/...",
  "gitBranch": "master",
  "userType": "external",
  "entrypoint": "cli",              // cli | sdk-ts | ...
  "type": "user",
  "isMeta": false,                  // true = 系统注入而非用户输入
  "message": { ... }
}
```

⚠️ **没有全局单调序号**。顺序靠数组物理顺序 + `parentUuid` 树。**不要试图用 timestamp 排序**（同毫秒多条、时钟可回拨）。

### 2.3 `type` 全清单 **[实测采样]**

| type | subtype | 关键字段 | 说明 |
|---|---|---|---|
| `user` | — | `message`, `isMeta`, `promptId`, `promptSource`, `sourceToolUseID`, `sourceToolAssistantUUID`, `toolDenialKind`, `toolUseResult` | 用户输入 **或** 工具结果回填 |
| `assistant` | — | `message{model, content[], usage, stop_reason}`, `requestId`, `effort`, `error` | 模型输出 |
| `system` | `turn_duration` | **`durationMs`**, `messageCount`, `pendingBackgroundAgentCount` | ⭐ **turn 边界 + 时长** |
| `system` | `stop_hook_summary` | `stopReason`, `hookCount`, `hookErrors`, `hookInfos`, `preventedContinuation`, `level`, `toolUseID` | Stop hook 结果 |
| `system` | `away_summary` / `local_command` | `content` | 杂项 |
| `attachment` | — | `attachment{...}` | 附件（数量很多，**默认过滤掉**） |
| `file-history-snapshot` | — | `snapshot`, `messageId`, `isSnapshotUpdate` | 文件编辑快照（**与轨迹无关，量大**） |
| `file-history-delta` | — | `trackingPath`, `backup` | 同上 |
| `cost-state` | — | ⭐ 见下 | 累计成本 |
| `last-prompt` | — | `lastPrompt`, `leafUuid` | UI 辅助 |
| `mode` / `permission-mode` / `atis-latch` | — | `mode`/`permissionMode`/`atis` | UI 辅助 |
| `queue-operation` | — | `operation`, `content`, `reason` | 排队编辑 |
| `ai-title` | — | `aiTitle` | 自动标题 |

**[推断]** 前 5 类（`user` / `assistant` / `system:turn_duration` / `system:stop_hook_summary` / `cost-state`）构成轨迹主体，其余是 UI 状态与文件快照。

### 2.4 `message.content` 块类型 **[实测]**

assistant 与 user 都有 `message.content`，是**块数组**（user 也可能是纯字符串）：

| block.type | 字段 | 说明 |
|---|---|---|
| `text` | `text` | 文本 |
| `thinking` | `thinking`, `signature` | ⭐ **明文思维链，可展示** |
| `tool_use` | `id`, `name`, `input`(对象) | 工具调用 |
| `tool_result` | `tool_use_id`, `content`(字符串或数组), `is_error` | 工具结果（在 **user** 记录里） |

**assistant 完整示例**：
```jsonc
{ "type": "assistant", "uuid": "658a78bf-...", "parentUuid": "c76f484c-...",
  "message": {
    "id": "06ec85c9298cbee2448c02dbd0adc56b",
    "type": "message", "role": "assistant",
    "content": [
      { "type": "thinking",
        "thinking": "The user wants me to analyze the current project...",
        "signature": "14f3e3d914c2a7e7..." }
    ],
    "model": "MiniMax-M2.7",
    "stop_reason": "tool_use",
    "usage": {
      "input_tokens": 6760,
      "cache_creation_input_tokens": 27583,
      "cache_read_input_tokens": 0,
      "output_tokens": 109,
      "output_tokens_details": { "thinking_tokens": 49 },
      "service_tier": "standard",
      "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 },
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "speed": "standard"
    }
  },
  "effort": "high",
  "requestId": "req_...",
  "attributionSkill": "oh-my-claudecode:ultragoal",
  "attributionPlugin": "oh-my-claudecode"
}
```

⚠️ **usage 是「这一条 assistant 消息」的用量，不是会话累计，也不是「一次模型请求」的聚合** —— 一个 turn 内可能有多条 assistant 记录（工具循环），每条各带 usage。累计要自己加。

**tool_result 完整示例（在 user 记录里）**：
```jsonc
{ "type": "user", "uuid": "7eba8449-...", "parentUuid": "94189874-...",
  "message": { "role": "user", "content": [
    { "tool_use_id": "call_64c2dd60385f4b3b8b0ad42c",
      "type": "tool_result",
      "content": "0.1_现有模型参数定价.md\n0.2_研究实验和环境.md\n...",
      "is_error": false }
  ]},
  "toolUseResult": {                      // ⭐ 结构化原始结果，Bash 工具才有
    "stdout": "...", "stderr": "", "interrupted": false,
    "isImage": false, "noOutputExpected": false
  },
  "sourceToolUseID": "call_64c2dd60385f4b3b8b0ad42c",
  "sourceToolAssistantUUID": "94189874-..."
}
```

### 2.5 turn 边界的还原

**Claude Code 没有 turn_id。** 两种可用切法 **[实测 + 推断]**：

1. **`system:turn_duration` 记录**（推荐）：出现在一个 turn 结束时，带 `durationMs` + `messageCount`（该 turn 内的消息条数）。
   ```
   ... user(prompt)
       assistant × N   ← 工具循环
       user(tool_result) × N
       ...
       system{ subtype:"turn_duration", durationMs:20558, messageCount:44 }   ← turn 结束
   ```
   **把每条 `turn_duration` 之前、上一个 `turn_duration` 之后的记录归为一个 turn。**

2. **真实用户 prompt 边界**：`user` 记录且 `isMeta === false` 且 `message.content` 是**字符串**（不是块数组）→ 一个新 turn 开始。

⚠️ **`messageCount` 的计数口径未确认**（是否含 system/attachment）。用它做交叉校验，不要当唯一依据。

### 2.6 step 的还原

同样需要自己推断。建议口径：
- 一个 `assistant` 记录 = 一个模型 step
- 其后连续的 `tool_result`（user 记录）= 该 step 的工具循环产物
- 直到下一个 `assistant` 记录或 turn 结束

### 2.7 子 agent

- `isSidechain: true` 的记录属于 Task 派生的子 agent。
- 子 agent 内容写在**同一个文件**里（实测）或独立 `agent-*.jsonl` 文件（新版可能）。
- 归组方式：子 agent 的记录 `parentUuid` 指向发起它的 `tool_use` 记录。**用 `parentUuid` 向上回溯到主会话的 tool_use，即得父子关系。**

### 2.8 `cost-state`（会话级累计）**[实测]**

```jsonc
{ "type": "cost-state", "sessionId": "...",
  "totalCostUSD": 13.687935250000006,
  "totalAPIDuration": 404260,              // ms
  "totalAPIDurationWithoutRetries": 403667,
  "totalToolDuration": 6526,
  "totalDuration": 2935844,
  "totalLinesAdded": 315, "totalLinesRemoved": 0,
  "startTime": 1788694992274,
  "modelUsage": {
    "MiniMax-M2.7": { "inputTokens":1999883, "outputTokens":17810,
                      "cacheReadInputTokens":1996611, "cacheCreationInputTokens":252743,
                      "webSearchRequests":0, "costUSD":13.02 }
  },
  "hasUnknownModelCost": true }
```
⚠️ `cost-state` 是**周期性快照**，不是增量。要么取最后一条，要么自己做差分。

### 2.9 Claude Code 侧的已知缺口

| 想要 | Claude Code 有吗 |
|---|---|
| 思维链 | ✅ 明文 |
| 逐工具耗时 | ❌ 无直接字段；可由 `tool_use.timestamp → tool_result.timestamp` 差值近似 **[推断]** |
| turn 时长 | ✅ `turn_duration.durationMs` |
| TTFT | ❌ 无 |
| 子 agent 结构 | ⚠️ 靠 `isSidechain` + `parentUuid` 推断 |
| token / cost | ✅ 最完整（逐条 usage + 会话 cost-state） |

---

## 3. 方案 C：DSH 自身 session log（格式参考 / 第三数据源）

### 3.1 存储布局 **[代码]**

```
<root>/--<projectKey(cwd)>--/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
<root>/--<projectKey(cwd)>--/<encodeSegment(sessionId)>/session.lock        # flock(2) 单写者
```

- `projectKey(cwd)`：把 `/ \ :` 折叠成 `-`，其他非 `[A-Za-z0-9._-]` 转 `~XXXX`，前后加 `--`，截断 251 字符（`session-persistence-jsonl/src/format.ts:225`）。
- `encodeSegment(sessionId)`：逐 UTF-16 码元转义成单射可逆路径段（`:199`）。
- **默认 zstd 压缩**，物理容器是**独立 Zstandard frame 的串联流**（magic `0xFD2FB528`，每帧带 checksum）。第 1 帧只含 header 行，之后每个写批次一帧（`zstd.ts:1-30,43`）。
- 一个 session 一个专属目录。
- 写入有 200ms 批处理窗口（`storage.ts:36` `LIVE_WRITE_BATCH_MAX_DELAY_MS`）。

👉 **建议优先走导出 ZIP 而不是直接解 zstd**（见 3.5）。

### 3.2 行结构 **[代码]**

**第 1 行 header**（`format.ts:83-91`）：
```jsonc
{ "type":"session", "version":4, "id":"<SessionId>", "createdAt":<epoch ms>,
  "isSeeded":false, "delegationDepth":0,
  "cwd":"...", "parentSession":"...", "origin":"subagent", "agentPreset":"..." }
```
必填：`type/version/id/createdAt/isSeeded/delegationDepth`；其余可选。**出现 `sandboxMode`/`approvalPolicy` 直接拒绝**（已退役）。

**第 2..N 行事件**（`packages/core/session/src/types.ts:493-523`）：
```ts
interface SessionEvent<T> {
  type: SessionEventType        // = keyof SessionEventMap（含插件声明合并）
  seq: SessionSeq               // 从 0 起、严格连续、无空洞 —— 权威顺序
  time: number                  // epoch ms；可能相同甚至逆序，不可作排序依据
  data: SessionEventMap[K]
  ignorable?: true              // 不认识 type 的读者可跳过；缺省 = 必需，必须拒绝
  surfaceOp?: 'append' | { op:'replace', startSeq, endSeq }   // 仅 5 种 surface 事件
  sourceEventSeqs?: SessionSeq[] // 引用图；可能是 [start,end] 行程压缩对
}
```

### 3.3 核心事件 **[代码]**

| type | 类别 | payload 要点 |
|---|---|---|
| `turn/start` / `turn/end` | log-only | `turn`; `reason: TurnEndReason`（completed/aborted/blocked/error/max-tokens/interrupted/forked） |
| `step/start` / `step/end` | log-only | `turn`, `step` ← **DSH 唯一有显式 step 的** |
| `user/message` | surface | `message: UserMessage` |
| `developer/message` | surface | `turn`, `step`, `message`, `headerSeq?` |
| `system/message` | surface | `turn`, `step`, `message` |
| `assistant/message` | surface | `turn`, `step`, `message`, **`stream: AssistantStreamRecord[]`**, **`usage?: TokenUsage`**, `interrupted?` |
| `assistant/attempt` | log-only | `turn`, `step`, `stream` |
| `tool/call` | log-only | `turn`, `step`, `callId`, `name`, `arguments`(**原始 JSON 字符串**) |
| `tool/result` | surface | `turn`, `step`, `message: ToolResultMessage`, `error?:{name,code,reason?}`, `meta?` |
| `request/header` | log-only | `header: EpochHeader{config, adapterDefaults?, tools?}`, `reason`, `startsSeries?` |
| `request/context` | log-only | `provider`, `model`, `contextWindow?`, `systemPromptUpdate?` |
| `compaction/start` `/summary` `/prune` `/end` | log-only | `compactionId`, `turn`, `shadowedRange`, `shadowedSeqs`, `usage?` |
| `subagent/descriptor` / `subagent/catalog` | log-only | `SUBAGENT_DESCRIPTOR_VERSION=3`；父子登记 |
| `hook/invoked` / `hook/result` | log-only | `turn`, `point`, `dialect`, `handlerId`; result 带 `durationMs` |
| `llm/retry-started` / `llm/retry` | log-only | 重试链 |
| `image/offload` | log-only | `targets:[{seq, imageIndexes[]}]` — 唯一带 `@messageProjection` 的类型 |

全量 57 个类型见 `packages/core/session/src/known-event-types.ts:22` 与生成的 `docs/persistence-catalog.md`（含每事件 payload + `file:line` + SHA-256 指纹）。

### 3.4 token 级时间轴（DSH 独有优势）**[代码]**

`AssistantStreamRecord`（`packages/llm/llm/src/assistant-stream.ts:20-46`）是压缩过的流记录：

```ts
// 压缩形式
{ type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks',
  time0: number, index: number, dt: number[],
  texts?: string[] | args?: string[] }
// 或原始形式
{ type:'chunk', time: number, chunk: StreamChunk }
```

**还原第 i 个 chunk 的时刻 = `time0 + Σ dt[0..i-1]`**。这是三个方案里唯一能拿到 **token 级时间戳** 的，能直接画 throughput 曲线。

`TokenUsage`（`packages/llm/llm/src/types.ts:175-188`）：`inputTokens`、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、`cacheWriteTokens?`、`reasoningTokens?`。
⚠️ **计数互斥**：`inputTokens` 是**未缓存**输入，缓存单独报。总输入需自己求和。

**没有独立的 usage 事件** —— token 只在 `assistant/message.usage` 里。

### 3.5 导出 ZIP（最省事的入口）**[代码]**

`GET /api/session.export?sessionId=…&includeDescendants=true` → `dsh-session-<id>.zip`：

```
session.jsonl                 # 或 session.vN.jsonl，未压缩，可直接 JSON.parse
subagents/<id>/session.jsonl
media/<attachmentId>.<ext>    # 图片，扩展名由 mediaType 决定
files/<digest-prefix>/<digest>/<name>
```

- **无 manifest**。
- `serializeSessionLog()`（`session-log-export/src/archive.ts:110-136`）：第 1 行 header，之后每行 `JSON.stringify(event)`。
- ⚠️ 这里直接 stringify **逻辑事件**，**不经过 `encodeCurrentEvent` 的 `sourceEventSeqs` 行程编码** → 导出文件的 `sourceEventSeqs` 是展开的完整数组，比磁盘格式更好解析。

### 3.6 SQLite（**不要当事件来源**）**[代码]**

`packages/session-query/session-query-sqlite/src/schema.ts`：

- `SCHEMA_VERSION = 8`，`APPLICATION_ID = 0x44534851`；`application_id` 不匹配 → 拒绝打开；`user_version !== 8` → **原地重置重建**。
- 表：`search_state`(singleton, global_generation)、`persisted_sessions`(id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)、`persisted_docs`（**FTS5 虚拟表**，`tokenize='unicode61'`，索引列 `text`，UNINDEXED：`session_id/seq/type/time/surface/codepoint_length`）。
- 临时表：`temp.live_sessions`、`temp.live_docs`。
- **无任何 `CREATE INDEX`**；排序靠 `match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC`。

👉 **它只存文本片段，没有 turn/step 结构、没有 payload。可以整体删除重建。做可视化必须回源 JSONL。**

---

## 4. 统一中间模型建议

三个源差异很大，建议先归一到一层中间表示，再做视图。

### 4.1 建议的中间结构

```ts
interface NormSession {
  source: 'codex' | 'claude-code' | 'dsh'
  sessionId: string
  cwd?: string
  gitBranch?: string
  startedAt?: number          // epoch ms
  cliVersion?: string
  model?: string
  // 源特有字段原样保留在 raw 里，不要丢
  raw?: unknown
}

interface NormTurn {
  index: number               // 本工具自己编号，从 0 起
  sourceTurnId?: string       // codex: payload.turn_id
  startedAt?: number
  endedAt?: number
  durationMs?: number         // codex: task_complete.duration_ms / claude: turn_duration.durationMs
  ttftMs?: number             // 仅 codex: time_to_first_token_ms
  endReason?: string          // completed / interrupted / max-tokens / ...
  steps: NormStep[]
}

interface NormStep {
  index: number
  startedAt?: number
  endedAt?: number
  ttftMs?: number
  decodeMs?: number           // endedAt - (start + ttft)
  usage?: NormUsage
  model?: string
  reasoning?: { available: boolean; text?: string; bytes?: number; encrypted?: boolean }
  toolCalls: NormToolCall[]
  textBlocks: NormBlock[]
}

interface NormToolCall {
  callId: string
  name: string
  input: unknown              // 解析后的对象；codex custom_tool_call 是源码字符串，保留原样
  inputRaw?: string
  output?: unknown
  outputText?: string
  isError?: boolean
  startedAt?: number
  endedAt?: number
  durationMs?: number
  parentCallId?: string       // subtool 归属
  unresolved?: boolean        // 只有 call 没有 output
}

interface NormUsage {
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  costUsd?: number
  scope: 'record' | 'turn' | 'session'   // codex token_count 与 claude usage 口径不同，必须标
}
```

### 4.2 字段映射表

| 目标字段 | Codex | Claude Code | DSH |
|---|---|---|---|
| sessionId | `session_meta.session_id` | `sessionId` | header `id` |
| cwd | `session_meta.cwd` | `cwd` | header `cwd` |
| turnId | `event_msg.*.turn_id` | ❌（靠 `turn_duration` 切） | `turn/start.data.turn` |
| step 边界 | ❌（自造） | ❌（每条 assistant 一 step） | `step/start.data.step` |
| 用户输入 | `response_item.message{role:'user'}` | `user` 且 `isMeta=false` 且 content 为字符串 | `user/message` |
| 助手文本 | `response_item.message{role:'assistant'}.content[].text` | `assistant.message.content[].text` | `assistant/message.message.content[].text` |
| 思维链 | `response_item.reasoning`（**加密**） | `assistant.message.content[].thinking`（**明文**） | `assistant/message.stream[type=reasoning-chunks]` |
| 工具调用 | `response_item.function_call{name,arguments}` / `custom_tool_call{name,input}` | `assistant.message.content[].tool_use{name,input}` | `tool/call{name,arguments}` |
| 工具结果 | `response_item.*_output{call_id,output}` | `user.message.content[].tool_result{tool_use_id,content,is_error}` | `tool/result{message,error}` |
| 工具耗时 | ❌ | ✅ 由 tool_use→tool_result 时间戳差 | ✅ 由 `tool/call`→`tool/result` 时间差 |
| usage | `event_msg.token_count.info.last_token_usage` | `assistant.message.usage` | `assistant/message.data.usage` |
| TTFT | ✅ `task_complete.time_to_first_token_ms` | ❌ | ✅ 由 stream `time0+Σdt` 推 |
| turn 时长 | ✅ `task_complete.duration_ms` | ✅ `system.turn_duration.durationMs` | 相邻 `turn/start`/`turn/end` 的 `time` |
| 子 agent | `agent_message.author/recipient` | `isSidechain:true` + `parentUuid` 回溯 | `subagent/catalog`（独立 session 文件） |
| 成本 | ❌ | ✅ `cost-state.totalCostUSD` | ❌ |

### 4.3 解析顺序建议

1. **扫目录拿文件列表**（Codex 可用 `session_index.jsonl` 快速列，但内容仍要读文件；Claude 无索引）。
2. **逐行 JSON.parse**，坏行跳过并计数（不要因为一行坏掉整个会话）。
3. **先做 surface / 可见性判定**（DSH：`surfaceOp: replace` 把被遮蔽事件标 shadowed；Codex/Claude 无此概念但有 `isMeta`）。
4. **按源权威顺序排序**：DSH 按 `seq`；Codex 按 `ordinal`；Claude 按**物理数组顺序**（不要按 timestamp）。
5. **切 turn**（见 1.5 / 2.5）。
6. **切 step**（自造口径，建议统一为"一次模型请求"）。
7. **配对工具调用**（按 `call_id` / `tool_use_id`）。
8. **累加 usage**，并标 `scope`。
9. **token 级时间轴**：只有 DSH 能做；Codex/Claude 只能在 step 粒度。

---

## 5. 采集方式

| 方式 | 适用 | 做法 |
|---|---|---|
| **全量读文件** | 历史回看 | 一次读入，`json.loads` 每行 |
| **增量 tail** | 准实时 | 记住 `(path, byteOffset)`，用 `fs.watch` + 增量读；**注意写到一半的行**，需缓存不完整尾行 |
| **轮询 mtime+size** | 简单可靠 | 每 1–2s 检查 size 变化，从 offset 续读。**比 tail -f 少踩坑** |
| **DSH 导出 ZIP** | 拿 DSH 数据 | `GET /api/session.export?sessionId=…&includeDescendants=true`，解 ZIP 得未压缩 JSONL |
| **Codex app-server** | Codex 实时旁路 | `codex app-server --stdio`，换行分隔 JSON-RPC 2.0。notification `turn/started` / `item/completed{threadId,turnId,item}` / `turn/completed{thread,status,error}` **[代码]** `packages/subagent/subagent-codex/src/wire.ts:632-702` |
| **Claude Agent SDK** | Claude 实时 | `@anthropic-ai/claude-agent-sdk` 的 `query()` message 流 **[代码]** `packages/subagent/subagent-claude-code/src/run.ts:242-258` |

⚠️ **DSH 自己在读这两个协议时丢弃了大量数据**（Claude 侧只认 `type==='result'`，Codex 侧只读 `turn.status/error/id`），所以**不要复用 DSH 的解析层，直接旁路**。**[代码]**

⚠️ **DSH 不支持导入外部 CLI 会话**：Claude 侧显式 `persistSession:false`，Codex 侧 `thread/start` 强制 `ephemeral:true` 且断言失败即抛错；全仓无任何读取 `~/.claude/projects/*.jsonl` / `~/.codex/sessions/*.jsonl` 的代码。**[代码]**

---

## 6. 已知风险与坑清单

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| 1 | Codex reasoning 加密 | 无法展示思维链 | 明确标"内容不可用"，展示字节数与是否存在 |
| 2 | Codex 双层数据（response_item + event_msg） | 只读一层丢一半 | 必须同时消费两层，用 `turn_id` 关联 |
| 3 | Claude cwd-slug 不可逆 | 无法从路径还原真实路径 | 以记录内 `cwd` 字段为准 |
| 4 | Claude 无 turn_id / 无 seq | 分组靠推断 | 用 `system:turn_duration` + `isMeta=false` 的 user 字符串双判据 |
| 5 | Claude `attachment` / `file-history-snapshot` 记录量巨大 | 解析慢、内存爆 | 默认过滤，只在需要文件变更视图时加载 |
| 6 | Codex `ordinal` 与 Claude 物理顺序 vs timestamp | 排序错乱 | 三个源各自用权威序，不用 timestamp |
| 7 | 孤儿 tool call / 孤儿 output | 配对失败 | `unresolved: true` 标记，不要丢弃 |
| 8 | Codex `cached_input_tokens` 口径不明 | token 统计偏差 | 单列展示并注明口径 |
| 9 | Claude usage 是逐条 assistant 消息 | 误当 turn 总量 | 自己加总并标 `scope` |
| 10 | DSH SQLite 会被自动重置 | 索引丢失 | 只当缓存，不当数据源 |
| 11 | DSH zstd 是**帧串联**不是单流 | 标准 zstd 解压器可能只解第一帧 | 用导出 ZIP，或实现帧扫描（magic `0xFD2FB528`） |
| 12 | DSH 未知 `type` 必须检查 `ignorable` | 静默丢弃会重建出错误 session | 不认识且 `ignorable!==true` → 明确报错 |
| 13 | DSH fork 子会话共享前缀事件 | 父子重复统计 | 按 `session/end-seed {inherited:true}` 切前缀 |
| 14 | 两边都在快速演进 | 字段增删 | 解析器对未知字段宽容、对未知类型严格；记录 `cli_version` |

---

## 7. 参考索引

**本机实测样本来源**
- `~/.codex/archived_sessions/rollout-2026-08-01T00-42-44-019fb90e-*.jsonl`（362 行）
- `~/.codex/sessions/2026/10/07/rollout-*.jsonl`
- `~/.claude/projects/-Users-yuanye-CODE-Harness-oh-my-claudecode/dcd4f880-*.jsonl`
- `~/.claude/projects/-Users-yuanye-Documents-ObsidianVault-naren_vault/98c08cba-*.jsonl`

**DSH 关键源码**
| 主题 | 位置 |
|---|---|
| `SESSION_FORMAT_VERSION = 4` | `packages/core/session/src/types.ts:89` |
| `SessionEvent` 信封 | `packages/core/session/src/types.ts:493-523` |
| `seq`/`time` 分配 | `packages/core/session/src/index.ts:742-743` |
| 57 个事件类型清单 | `packages/core/session/src/known-event-types.ts:22` |
| 生成的全量事件目录（含指纹） | `docs/persistence-catalog.md`、`docs/persistence-schema.json` |
| 格式版本状态 | `docs/session-format-status.md` |
| HeaderLine / 路径编码 / 压缩 | `packages/session/session-persistence-jsonl/src/format.ts:83,199,225` |
| zstd 帧扫描 | `packages/session/session-persistence-jsonl/src/zstd.ts:43` |
| `AssistantStreamRecord` | `packages/llm/llm/src/assistant-stream.ts:20-46` |
| `TokenUsage` | `packages/llm/llm/src/types.ts:175-188` |
| SQLite schema | `packages/session-query/session-query-sqlite/src/schema.ts:8-166` |
| 导出 ZIP 布局 | `packages/session-query/session-log-export/src/archive.ts:1-20,110-136` |
| Codex app-server wire | `packages/subagent/subagent-codex/src/wire.ts:632-702` |
| Claude Agent SDK 消费 | `packages/subagent/subagent-claude-code/src/run.ts:242-258` |
| Hook bridge（稀疏，不推荐） | `packages/hooks/hook-protocol/src/events.ts:75-103` |

**DSH 前端参考（如果要做成 DSH 内插件）**
| 主题 | 位置 |
|---|---|
| Conversation 装配总纲 | `docs/subsystems/conversation.md` |
| Web Client 分层 | `docs/subsystems/web-client.md` |
| Trajectory 视图 README | `packages/client/ui-trajectory/README.md` |
| 轨迹行布局算法 | `packages/client/ui-trajectory/src/client/layout.ts` |
| 轨迹时间线投影 | `packages/client/ui-trajectory/src/client/timeline.ts` |
| 轨迹虚拟滚动 | `packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts` |
| 对话装配器 | `packages/client/ui-conversation/src/client/conversation/assembler.ts` |
