// The three ways the Herder can talk (ADR 0053), as the settings page and the first run show them.
// The words the Herder itself follows live in the Herder's prompt; these are only labels.

import type { HostStatus } from "@agentherd/host/api";

export type HerderStyle = HostStatus["herderStyle"];

export interface HerderStyleLabel {
  style: HerderStyle;
  title: string;
  /** Which personal agent the style is copied from. */
  from: string;
  /** One line on how it talks. */
  hint: string;
  /** A message in this style, about the same work, so the three can be compared. */
  sample: string;
}

export const HERDER_STYLE_LABELS: readonly HerderStyleLabel[] = [
  {
    style: "friend",
    title: "能干的朋友",
    from: "参考 open-instinct",
    hint: "温和直接，像朋友发消息，说重点",
    sample:
      "learnspace 那个查完了，#2000 还剩三处小问题，我顺手改了？另外有 8 个没人认领的，最好上手的是 #1743。",
  },
  {
    style: "partner",
    title: "有主见的搭档",
    from: "参考 OpenClaw",
    hint: "有自己的看法，会直说哪里不对、值不值得做",
    sample:
      "查完了。说实话锚点那条我不太信，VitePress 会把它生成对的，先别动。值得做的是 #1743，原型都有了。",
  },
  {
    style: "secretary",
    title: "干练秘书",
    from: "参考 Vercel 个人 agent 模板",
    hint: "先说结果，再说要你做什么，没有寒暄",
    sample: "已完成：#2000 剩 3 处文档问题；8 个可做 issue，建议先做 #1743。需要我先改 #2000 吗？",
  },
];

/** The style a new install starts with; the host uses the same default. */
export const FIRST_HERDER_STYLE: HerderStyle = "friend";
