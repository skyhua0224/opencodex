[English](README.md) | **简体中文**

# 我 fork 的 opencodex（2.63.0）

上游是 [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)，MIT。我这份就是把官方 2.63.0 拿来，把真实用起来必须改的地方改掉，然后自己一直用。两个镜像内容一样：

- GitHub：<https://github.com/skyhua0224/opencodex>
- Gitea：<https://gitea.sky-hua.xyz:24443/skyhua/opencodex>

## 为什么要改

官方这版在我这儿有几个问题，而且不是配置能解决的：

1. 官方的 capacity 判定会直接弹到客户端（`Selected model is at capacity`），可它其实是**先把请求受理了、过一会儿才拒绝**的，重试一次基本就能好。它却当场就把这趟判死，一次接一次。
2. combo 阶梯碰上某一行的一条怪答复就整趟停住，后面的渠道压根没轮到。
3. 中继站的额度只在人家网页控制台里能看到，代理这边不知道，于是一直去撞已经用完的站。
4. 官方 WebSocket 车道会按会话悄悄变差：同一个账号、同一个模型，一个会话一直慢一直 capacity，另一个会话啥事没有。

改法（细节、每处阈值的实测依据都在 [FORK-NOTES.md](FORK-NOTES.md)，英文）：

- **capacity 不再冒到客户端**。先在同一个 socket 上重发；不行就把 prelude 暂存住等一会儿；再不行结算成一个能重放的 503，让上层换条**新连接**重来；最后还有 5s / 12s / 25s / 45s 的阶梯。SSE 那条路一样处理（后端先回 200、再把 overload 塞进流里的情况也吞掉重来）。已经出过字的那种不重发，重发就是重复生成，交给 Codex 自己重试。
- **combo 阶梯一路走到底**。额度耗尽的站直接跳过，不当成墙；只有官方那一行进 10m → 1h → 3h → 6h → 12h → 24h 的冷静期；全都不行了就回 `503 combo_unavailable` 加 `Retry-After`，而不是回一个 Codex 根本不重试的裸 429。输出开始复读（重复片段、重复的工具调用）就把那行停 2 分钟，不禁用渠道。
- **按会话换身份**。某个会话一直挨丢，就让它暂时不走 WebSocket，并把它独有的两个路由线索丢掉（客户端的 `x-codex-window-id`、服务端的 `x-codex-turn-state`），让后端重新安置它。这个状态会存盘，重启不丢。
- **控制台里的额度喂给路由**。面板型订阅、自定义窗口、秒级重置时间戳、`>= 100%` 就当耗尽。
- gpt-6 那批模型目录，以及加固要用到的供应商字段（`retryOnReset`、瞬时 5xx 策略、推理档位、上下文窗口）。

## 怎么装

```bash
git clone https://github.com/skyhua0224/opencodex.git
cd opencodex
npm install -g .        # 或者 bun install -g .
ocx setup
ocx start
```

Node 18+ 就行，Bun 是 npm 装依赖时自带的，Windows 也不用 WSL。三个系统官方都支持：macOS（launchd）、Linux（systemd 用户服务）、Windows（任务计划程序，或者 `--native` 走 WinSW 原生服务）。

自测（需要 bun）：

```bash
bun test/codex-ws-capacity-selftest.ts
bun test/sse-prelude-retry-selftest.ts
bun test/capacity-absorb-selftest.ts
bun test/thread-affinity-selftest.ts
```

## 几件要注意的

- 这份锁在 **2.63.0**。**别跑 `ocx update`**，一跑就把官方版装回来、我的改动全没了。要跟新版本就照 FORK-NOTES 里那段，用 `patches/` 里的补丁在干净的新版本上重打一遍。
- `src/oauth/google-antigravity.ts` 里那两个 Google 标识是上游自带的（文件注释里就写了是 Antigravity 桌面客户端的公开标识，可用环境变量覆盖）。想用自己的就设 `GOOGLE_ANTIGRAVITY_CLIENT_ID` / `GOOGLE_ANTIGRAVITY_CLIENT_SECRET`。仓库里没别的凭据。
- prelude 暂存最长会让首包晚 25 秒，但只在后端迟迟不出字的时候；一出内容立刻放行。
- 阈值都是按 2026 年 9 月的实测调的，代码里每处常量都写了为什么，当起点用，别当真理。
- 我只在 Linux 上实跑过。代码里没有平台相关的分支、自测也跨平台，但 macOS / Windows 上我没跑过测试；哪边出问题先跑上面那四个脚本，能直接分清是改造逻辑还是环境问题。

许可证还是 MIT，保留上游的版权声明，见 [LICENSE](LICENSE)。
