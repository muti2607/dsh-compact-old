# dsh-compact-old

压缩**已经堆积过长的会话**。宿主自带的 `/compact` 只能作用于当前会话，这个插件补上「指定任意已加载的老会话」的能力。

## 能做什么

- 列出当前所有**已加载、可压缩**的活会话（含 id / 标题 / 状态）
- 按 **会话 id** 或**标题模糊匹配**指定目标，把较早的历史替换成一条摘要
- 压缩结果写回原会话日志（`compaction/summary`），近期对话不受影响

底层调用宿主的 `ctx.compaction.compactNow(agent, signal)`，和 `/compact` 是同一套压缩实现，不是自己另造一套摘要。

## 用法

### 方式一：让 Agent 直接做

```
压缩一下「微信群聊机器人接入」那个老会话
列出可以压缩的会话
```

工具 `compact_old_session` 会自动调用。不带参数时只列清单、不执行压缩；
列表带会话标题，所以按标题点名即可。

实测：对一个堆积的老会话执行后返回「已压缩 607 条历史项，近期对话不受影响」。
太短的会话宿主会判定压不出更小的摘要，插件如实报「无需处理」，不算失败。

### 方式二：HTTP 接口

```bash
# 列出会话
curl http://127.0.0.1:<dsh端口>/api/compact-old/sessions

# 压缩指定会话
curl -X POST http://127.0.0.1:<dsh端口>/api/compact-old/compact \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<会话 id>"}'
```

## 前置条件

必须先启用宿主的压缩服务，即安装 **`dsh-compaction-enable`**（把 `compaction-basic` / `command-compact` / `tool-result-pruner` 三行打开）。没装的话接口会明确报 `no-compaction-service`，不会静默失败。

## 硬限制（宿主契约，绕不过）

| 情况 | 能否压缩 |
| --- | --- |
| 已加载、且当前**空闲**的会话 | ✅ 可以 |
| 已加载、但正在跑一轮对话 | ❌ 报 `busy`，等跑完再试 |
| 磁盘上已持久化、但**没在界面里打开**的历史会话 | ❌ 报 `unloaded` |

`compactNow` 需要一个活着的、处于 idle 的 Agent 才能安全改写会话日志。**想压缩一个没打开的老会话，请先在界面里点开它（resume）**，让它成为活会话，再调用本插件。这是宿主压缩服务的约束，插件不会（也不应该）直接改写 JSONL 文件。

## 配置

```yaml
- id: compact-old
  name: dsh-compact-old
  config:
    exposePersistedFiles: false   # true = 在 /sessions 里返回已持久化文件的绝对路径
```

默认不暴露文件路径，只返回 id 与大小。
