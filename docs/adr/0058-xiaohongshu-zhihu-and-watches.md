# ADR 0058: The owner's 小红书 and 知乎, and one list of everything watched

- Status: Accepted (小红书 built; 知乎 waiting for a sign-in test)
- Date: 2026-11-11
- Builds on: [ADR 0048](0048-watch-mail-only-when-asked.md) (mail watches), [ADR 0052](0052-offer-new-github-work-when-asked.md) (new work), [ADR 0056](0056-leaving-the-mac-asks-and-questions-close.md) (leaving the Mac)
- Changes: [09-agent-tools §6](../spec/09-agent-tools.md), [04-herder](../spec/04-herder.md), [07-delivery](../spec/07-delivery.md)

## Context

The owner asked for 小红书 and 知乎: agents should search, read and (with the owner's OK) post,
comment and reply under the owner's account, and AgentHerd should tell the owner about new
comments and @ like it does for pull requests and mail. Neither platform gives individuals an API:
小红书's open platform needs a business, 知乎 has none. Composio has neither. What exists is
browser automation with the owner's own cookies; the best kept one is
[xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (Apache-2.0, 17k★,
signs in by QR code, search, read, publish, comment, reply, like, notices). For 知乎 only tiny,
unlicensed projects exist.

The owner also wanted (2026-11-11): watching on by default but switchable, a low frequency, a risk
notice before a platform is turned on, and one page 「应用连接」 that lists every watch.

## Decision

1. **小红书 runs xiaohongshu-mcp.** The host downloads one pinned release
   (`v2.7.4`, `xiaohongshu-mcp-darwin-arm64`, to `~/.agentherd/bin/`) the first time the owner turns
   小红书 on, and starts it on `127.0.0.1` at a free port with a random bearer token, its cookies in
   `~/.agentherd/xiaohongshu/cookies.json` and a fixed fingerprint seed per Mac (`XHS_FP_SEED`, in
   config.json). It is stopped when turned off or when AgentHerd quits; the sign-in stays.
2. **Turning on needs the notice.** 应用连接 shows what can happen (the platform may limit or close
   an account it thinks is automated; writes ask first; looks are rare; sign-in stays on this Mac;
   use a second account if worried). The owner ticks 「我已了解风险」; the host refuses
   `enableSocial` without `accepted`. Sign-in is a QR code scanned with the platform's app.
3. **Agents use it through the gateway**, like Composio apps: tools are listed as
   `XIAOHONGSHU_<TOOL>`; the sign-in tools are hidden. Reads pass. Publishing, commenting,
   replying, liking and saving leave the Mac and ask (ADR 0056: likes, saves and follows now count
   as `comment`, because they show under the owner's name), unless the request allowed it.
4. **Notices are looked at rarely.** Every 20 minutes give or take 5, only while a platform is
   signed in and watches something. A look reads the unread counts first and opens a list only
   when it has something unread; the first look of a kind only learns what is there. New comments
   and @ are told one per line (three at most, then a count); likes and follows are counted. The
   Herder hears what was told, so 「回她一下」 makes sense.
5. **Defaults:** comments and @ on; likes and saves, new followers off. The owner switches them in
   the app or by telling the Herder (`social_watch`).
6. **One list of watches.** 应用连接 → 监听 lists pull requests tasks opened, mail watches, new
   GitHub work and platform watches. Each can be paused (kept, not looked at; `paused` in its
   herd.db row) and, except platform kinds, removed. Composio apps moved from 设置 to this page.
7. **知乎** waits: its web API signs requests (`x-zse-96`), and no maintained server exists. It
   shows in the app as not ready until a sign-in test with the owner's account decides between a
   browser server like 小红书's and our own client.

## Alternatives

- **Agent-Reach** (read-only CLI for many sites): no writing, no notices.
- **Polling every few minutes like GitHub:** each look is a browser visit with the owner's
  account; platforms watch for robots. Twenty minutes is the owner's "降低一些".
- **Telling every like:** noise; off by default, counted when on.

## Consequences

- A 17 MB binary and a headless Chrome run while 小红书 is on. Only Apple-silicon Macs for now.
- The account risk is the owner's; the notice says so, and nothing writes without asking.
- Reading the notice lists marks them read on 小红书, as opening the app would.
