[English](README.md) | **简体中文**

# opencodex — skyhua 的加固分支

基于 **opencodex 2.63.0**（MIT）的分支。上游：<https://github.com/lidge-jun/opencodex>。
镜像：[GitHub](https://github.com/skyhua0224/opencodex) · [Gitea](https://gitea.sky-hua.xyz:24443/skyhua/opencodex)。

这个分支针对 ChatGPT Codex 后端的**真实行为**做了一组加固：请求被受理之后才到达的 capacity 判定、组合阶梯因为某一行的一条答复就整趟失败、只存在于网页控制台的供应商额度、以及会按会话悄悄降级的 WebSocket 车道。每一项改动背后的测量数据、以及如何把它重放到新的上游版本，都写在 **[FORK-NOTES.md](FORK-NOTES.md)**（英文）。

## 安装

```bash
git clone https://github.com/skyhua0224/opencodex.git
cd opencodex
npm install -g .        # 或：bun install -g .
ocx setup               # 之后：ocx start
```

只需要 Node 18+，Bun 由 `npm install` 自带；Windows 不需要 WSL。上游支持矩阵：macOS（arm64/x64，launchd）、Linux（x64/arm64，systemd user unit）、Windows（x64，任务计划程序或可选原生服务）均完全支持。

自测（需要 bun，跨平台）：

```bash
bun test/codex-ws-capacity-selftest.ts
bun test/sse-prelude-retry-selftest.ts
bun test/capacity-absorb-selftest.ts
bun test/thread-affinity-selftest.ts
```

## 这个分支加了什么（一屏）

- **官方车道上，capacity 判定不再冒到客户端**。四层，从便宜到贵：被拒的 create 帧首发先在同一个 socket 上重发；WebSocket 车道把 prelude 暂存住；实在不行结算成**可重放的 503**，让调用方**重拨一个新 socket**；再不行走 5s/12s/25s/45s 的节奏阶梯。SSE 车道同样处理：已经回了 200、但把拒因塞在**响应体里**的情况，会被吞掉并把新一趟的帧续进同一个响应体（`src/lib/sse-prelude-retry.ts`）。**已经出过内容的拒因照旧透传**——那种情况下重发就是重复生成，只能交给 Codex 自己重试。
- **组合阶梯会一路走到底**。某一行拒绝重放不再让整条阶梯停住；额度耗尽的站点是**跳过**而不是当成墙；只有官方那一行会进入 10m → 1h → 3h → 6h → 12h → 24h 的阶梯冷静；全梯队都不可用时回 `503 combo_unavailable` 加 `Retry-After`，而不是回一个 Codex 不肯重试的裸 429；输出退化（重复片段、重复的工具调用签名）会把那一行停 2 分钟，而不是禁用整个渠道。
- **按会话的传输策略**：持续被丢的会话会暂时离开 WebSocket 车道，并且**重投它的路由身份**——对该会话丢掉客户端的 `x-codex-window-id` 和服务端的 `x-codex-turn-state`，这个状态会持久化、重启不丢。
- **控制台才知道的额度**：面板型订阅（`/subscriptions/active`、`/subscriptions/progress`）会喂给路由：自定义窗口、以秒为单位的重置时间戳、`>= 100%` 判为耗尽。
- **模型目录与管理接口**：`gpt-6` 家族条目，以及加固需要的供应商字段（`retryOnReset`、瞬时 5xx 策略、推理档位、上下文窗口）。

## 与上游的关系、以及如何 rebase

- 本分支锁定在 **2.63.0**。`patches/` 里是同样一组改动，可以直接打到干净的 2.63.0 上：
  `patch -p1 < patches/opencodex-2.63.0-capacity-complete-20260924.patch`
  —— 这是把改动带到更新版本上游上最快的方式。
- **不要在这个 fork 上执行 `ocx update`**：它会把官方版本装回来、覆盖掉这些改动。
- 上游与本分支没有隶属关系：加固相关的问题提到本仓库，opencodex 本身的问题提到上游。

## 凭据说明

`src/oauth/google-antigravity.ts` 里带的是 **Antigravity 桌面客户端的公开 OAuth 标识**，与上游发布的一模一样（文件自带注释就写明是 public identifiers、可用环境变量覆盖；Google 桌面客户端的 client secret 按设计也无法保密）。想用你自己的凭据，设 `GOOGLE_ANTIGRAVITY_CLIENT_ID` 与 `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` 即可。本仓库中除此之外没有别的凭据。

## 注意事项

- 一些阈值是按 2026 年 9 月官方后端与中继的实测行为调的，代码里每处常量都写了它背后的测量；把它们当作起点，而不是物理定律。
- prelude 暂存**只在后端迟迟不产生内容时**才会让客户端的首包最多晚 25 秒；一旦有任何内容形状的事件到达，暂存的帧立刻放行。

## 许可证

MIT，未做改动，保留上游的版权声明——见 [LICENSE](LICENSE)。
