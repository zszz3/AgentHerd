import type { ToolCallInfo } from "@agentherd/protocol";
import { describe, expect, it } from "vitest";
import { appOutbound, outboundCheck } from "../src/outbound.ts";

const run = (command: string): ToolCallInfo => ({
  kind: "execute",
  title: command,
  command,
  paths: [],
});

describe("outboundCheck (ADR 0056)", () => {
  it.each([
    ["git push", "push"],
    ["git push --force origin main", "push"],
    ["git -C ../app push", "push"],
    ["cd app && git commit -am x && git push", "push"],
    ["FOO=1 git push", "push"],
    ["gh pr create --fill", "pull-request"],
    ["gh pr merge 12 --squash", "merge"],
    ["gh pr comment 3 -b hi", "comment"],
    ["gh pr review 3 --approve", "comment"],
    ["gh issue comment 9 --body ok", "comment"],
    ["gh issue create -t bug", "comment"],
    ["gh release create v1.0.0", "publish"],
    ["gh api -X POST repos/a/b/issues", "comment"],
    ["gh api repos/a/b/issues -f title=x", "comment"],
    ["npm publish", "publish"],
    ["pnpm publish --access public", "publish"],
    ["cargo publish", "publish"],
    ["docker push me/app:1", "publish"],
    ["vercel --prod", "deploy"],
    ["kubectl apply -f k8s.yaml", "deploy"],
    ["terraform apply", "deploy"],
    ["git send-email 0001.patch", "send"],
    ["lark-cli im +send --chat x --text hi", "send"],
    ["echo $(date) && git push", "push"],
  ])("%s → %s", (command, step) => {
    expect(outboundCheck(run(command))?.step).toBe(step);
  });

  it.each([
    "git commit -am wip",
    "git merge feature",
    "git checkout -b fix",
    "git fetch origin",
    "git pull",
    "gh pr view 12",
    "gh pr list",
    "gh pr checkout 12",
    "gh issue list",
    "gh api repos/a/b/pulls",
    "gh api -X GET repos/a/b",
    "pnpm test",
    "npm install",
    "docker build .",
    "kubectl get pods",
    "echo git push",
    "grep -r publish src",
  ])("%s stays on the Mac", (command) => {
    expect(outboundCheck(run(command))).toBeUndefined();
  });

  it("app tools that send, merge or open things leave the Mac; reads do not", () => {
    expect(appOutbound("GMAIL_SEND_EMAIL")?.step).toBe("send");
    expect(appOutbound("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL")?.step).toBe("send");
    expect(appOutbound("SLACK_SEND_MESSAGE")?.step).toBe("send");
    expect(appOutbound("GITHUB_MERGE_A_PULL_REQUEST")?.step).toBe("merge");
    expect(appOutbound("GITHUB_CREATE_A_PULL_REQUEST")?.step).toBe("pull-request");
    expect(appOutbound("GITHUB_CREATE_AN_ISSUE_COMMENT")?.step).toBe("comment");
    expect(appOutbound("GMAIL_FETCH_EMAILS")).toBeUndefined();
    expect(appOutbound("NOTION_CREATE_PAGE")).toBeUndefined();
    // 小红书 tools through AgentHerd (ADR 0058).
    expect(appOutbound("XIAOHONGSHU_PUBLISH_CONTENT")?.step).toBe("publish");
    expect(appOutbound("XIAOHONGSHU_POST_COMMENT_TO_FEED")?.step).toBe("comment");
    expect(appOutbound("XIAOHONGSHU_REPLY_NOTIFICATION")?.step).toBe("send");
    expect(appOutbound("XIAOHONGSHU_LIKE_FEED")?.step).toBe("comment");
    expect(appOutbound("XIAOHONGSHU_FAVORITE_FEED")?.step).toBe("comment");
    expect(appOutbound("ZHIHU_FOLLOW_QUESTION")?.step).toBe("comment");
    expect(appOutbound("XIAOHONGSHU_SEARCH_FEEDS")).toBeUndefined();
    expect(appOutbound("XIAOHONGSHU_LIST_NOTIFICATIONS")).toBeUndefined();
    expect(appOutbound("ZHIHU_GET_FOLLOWERS")).toBeUndefined();
  });
});
