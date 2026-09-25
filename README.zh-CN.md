[English](README.md) | **简体中文**

# opencodex — skyhua 的加固分支

基于 **opencodex 2.63.0**（MIT）的分支。上游：<https://github.com/lidge-jun/opencodex>。
镜像：[GitHub](https://github.com/skyhua0224/opencodex) · [Gitea](https://gitea.sky-hua.xyz:24443/skyhua/opencodex)。

## 解决的是什么问题

官方这版在真实使用里有几处必须改，而且都不是配置能绕过的：

1. **capacity 直接弹到客户端**。官方那个 `Selected model is at capacity` 其实是「先把请求受理、过一会儿才拒绝」，重试一次基本就好；现在却是当场把整趟判死，一次接一次。
2. **combo 阶梯一碰就停**。某一行回一条怪答复（比如连接被重置）就整趟停住，后面的渠道压根没轮到。
3. **中继额度只存在于网页控制台**。代理不知道哪个站已经用完，于是反复去撞已经耗尽的站。
4. **WebSocket 车道按会话悄悄变差**。同一个账号、同一个模型，一个会话一直慢、一直 capacity，另一个会话啥事没有。
5. **原生会话的复读没人管**。不走 combo 时，官方或中继开始重复同一段话，代理会照抄到客户端，直到客户端自己放弃；combo 有守卫，原生没有。
6. **被换模型、被降级看不出来**。上游报的模型和请求的不一致、服务等级比配置的低、官方声明安全缓冲要切到更快的模型——这些都不报错，也不留痕迹。

## 怎么改的

- **capacity 不再冒到客户端**。四层：先在同一个 socket 上重发；不行就把 prelude 暂存住等一会儿；再不行结算成可重放的 503，让上层换条**新连接**重来；最后还有 5s / 12s / 25s / 45s 的阶梯。SSE 那条路一样（后端先回 200、再把 overload 塞进流里也吞掉重来）。已经出过字的不重发——重发就是重复生成，交给 Codex 自己重试。
- **combo 阶梯一路走到底**。额度耗尽的站直接跳过、不当墙；只有官方那一行进 10m → 1h → 3h → 6h → 12h → 24h 的冷静期；全都不行了回 `503 combo_unavailable` 加 `Retry-After`，而不是回一个 Codex 根本不重试的裸 429。
- **按会话换身份**。某个会话一直挨丢，就暂时不走 WebSocket，并丢掉它独有的两个路由线索（客户端的 `x-codex-window-id`、服务端的 `x-codex-turn-state`），让后端重新安置它。状态存盘，重启不丢。
- **原生会话也做复读守卫**。前 4KB 算重复片段率、最长重复片段、zlib 压缩比，跨轮还比对工具调用签名；命中就切断这趟流（发 `response.failed` + `degenerate_output`），不再继续为循环付钱。原生没有第二行可换，“换”交给客户端重试，同时把判定记在这个会话上——下次它走 combo 时，会降级那个真正在复读的行。
- **模型、等级、安全缓冲全部留痕**。响应里报的模型与请求不一致、服务等级低于配置、官方声明安全缓冲会用更快的模型（例如 `gpt-6-luna`），都会写进 `~/.opencodex/model-attestation.jsonl` 并打一行日志；不报错，也不改写响应。
- **控制台里的额度喂给路由**。面板型订阅、自定义窗口、秒级重置时间戳、`>= 100%` 就当耗尽。
- **答错的渠道现在会真的让位**：`tools/pelican-probe.py --kind bank --apply` 问六道答案各自独立验证过的题
  （穷举、`datetime`、实际执行），判题交给另一家的模型；明确答错一次，该渠道被隔离 30 分钟、combo 里降一级；
  超时、鉴权失败、判不出一律什么都不动。整轮全对才解除。本机已装成每 30 分钟的 systemd 定时器；首轮就把官方车道
  隔离了——一道最小值可证为 21 的题它答了 29。
- **官方传输的车道级熔断**：上游只在 WebSocket 上发两个控制帧就 1011 断开时，以前每趟要走完整套
  5+12+25+45 秒阶梯再失败（单趟 97–106 秒，看起来就是卡住不出字）。现在这种形态会被计数，连续三次就把车道
  切到 HTTP/SSE 十分钟，重复触发升级到 30/60 分钟，证据写 `~/.opencodex/ws-lane.jsonl`；
  `provider.openai.upstreamWebsocket = false` 仍是手动开关，本机当前就跑在它上面。
- **健康分、指纹漂移、风控判定**：`ocx-tiers --health` 用错误率加 p90 首字给每家打分；`--fingerprints` 列出客户端
  指纹漂移（Codex 升级、中转改头不再是无声的）；针对"说的是客户端而不是负载"的判定（例如 only allows Codex
  official clients），第一次就重投该会话的路由身份，不再等负载阈值。- **带标准答案的测智探针**：`tools/pelican-probe.py` 用 sub2api 那两道题（题面、交付约定、`high` 推理档位、
  期望答案、判题规则全部照抄），通过本代理测任意渠道，判题交给**另一个渠道**的模型，结果写进
  `~/.opencodex/intelligence-probe.jsonl`。首轮结果：官方 `gpt-6-sol`/`luna`/`astra` 都把一道最小值为
  21 的题答成 29；`ciii-*` 返回 `Upstream authentication failed`；`lucen-*` 和 `portal` 全是
  `SUBSCRIPTION_NOT_FOUND`。
- **一条命令看结果**：`ocx-tiers` 直接看等级有没有掉、有没有被换模型、有多少条流因为复读被切；
  再加 `--links`（这条链路到底见没见过边缘的亲和 cookie）、`--latency`（慢的一趟时间花在哪一段）
  和 `--wsreuse`（三条 WebSocket 车道并排）、`--health`（每家健康分）、`--quality`（测智轮次与隔离）、
  `--fingerprints`（指纹漂移）。
- **prelude 之后 socket 断掉也能重拨**：只要一个字节都没放给客户端，就结算成可重放的状态交给阶梯重新拨号；
  只有已经出过帧的情况才按“有歧义”处理。
- **socket 池终于真的用上了**：有两个 bug 让它从来没接到过真实流量——客户端那个约 4KB、每次尝试都会换的
  `x-oai-attestation`，1) 超过会话身份继承下来的单字段上限，2) 又被算进 socket key，于是两次尝试永远对不上同一个 socket。
  现在超长字段只进哈希、按请求变化的头（attestation、client request id）不再参与身份：同一个会话的重试会落在上次留下的那个
  socket 上。跨 turn 复用它也已经实现，但**默认关闭**（`OCX_WS_CROSS_TURN_REUSE=1` 才开）——因为那条“首帧 8 秒”的兜底
  分不清“socket 已被上游退休”和“上游就是慢”，在上游几十秒才出字的时段反而更贵。

## 安装

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
bun test/response-guards-selftest.ts
bun test/codex-ws-capacity-selftest.ts
bun test/sse-prelude-retry-selftest.ts
bun test/capacity-absorb-selftest.ts
bun test/thread-affinity-selftest.ts
```

报表（看等级/换模型/复读）：

```bash
ocx-tiers --hours 6        # 等级、模型、复读三项汇总
ocx-tiers --findings       # 只列逐条记录
```

## 几件要注意的

- 这份锁在 **2.63.0**。**别跑 `ocx update`**，一跑就把官方版装回来、改动全没了。要跟新版本就照 [FORK-NOTES.md](FORK-NOTES.md) 里那段，用 `patches/` 里的补丁在干净的新版本上重打一遍。
- `src/oauth/google-antigravity.ts` 里那两个 Google 标识是上游自带的（文件注释里写明是 Antigravity 桌面客户端的公开标识，可用环境变量覆盖）。想用自己的就设 `GOOGLE_ANTIGRAVITY_CLIENT_ID` / `GOOGLE_ANTIGRAVITY_CLIENT_SECRET`。仓库里没别的凭据。
- prelude 暂存最长让首包晚 25 秒，但只在后端迟迟不出字的时候；一出内容立刻放行。
- 复读守卫的阈值（重复率 0.6、同一 40 字符片段 3 次、压缩比 8、同一工具调用 3 次）刻意保守：正常输出里的表格、测试清单不会命中。
- 阈值都是按 2026 年 9 月的实测调的，代码里每处常量都写了为什么，当起点用，别当真理。
- 只在 Linux 上实跑过。代码里没有平台相关的分支、自测也跨平台，但 macOS / Windows 上没跑过测试；哪边出问题先跑上面那几个脚本，能直接分清是改造逻辑还是环境问题。

许可证还是 MIT，保留上游的版权声明，见 [LICENSE](LICENSE)。
