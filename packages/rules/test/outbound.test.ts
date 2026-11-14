import type { ToolCallInfo } from "@agentherd/protocol";
import { describe, expect, it } from "vitest";
import { appOutbound, outboundCheck, pushPlans, stepsSaidIn } from "../src/outbound.ts";

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
    ["lark-cli docs +update --doc abc --markdown hi", "edit"],
    ["lark-cli calendar +create --summary 周会", "send"],
    ["lark-cli calendar events create --data '{}'", "send"],
    ["lark-cli base +record-create --base b", "edit"],
    ["lark-cli api POST /open-apis/docx/v1/documents", "edit"],
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
    "lark-cli docs +fetch --doc abc",
    "lark-cli docs +search --query 周报",
    "lark-cli docs +create --title 调研",
    "lark-cli sheets +create --title 数据",
    "lark-cli calendar +agenda",
    "lark-cli im messages list --chat x",
    "lark-cli im +messages-search --query hi",
    "lark-cli api GET /open-apis/calendar/v4/calendars",
    "lark-cli auth status",
    "lark-cli calendar +create --help",
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

describe("pushPlans (ADR 0064)", () => {
  const ctx = { cwd: "/p/app", home: "/Users/me" };
  const one = (command: string) => {
    const plans = pushPlans(command, ctx);
    expect(plans).toHaveLength(1);
    return plans?.[0];
  };

  it("reads where a push goes", () => {
    expect(one("git push")).toEqual({ dir: "/p/app", branches: [], current: true });
    expect(one("git push -u origin HEAD")).toEqual({ dir: "/p/app", branches: [], current: true });
    expect(one("git push origin fix/login")).toEqual({
      dir: "/p/app",
      branches: ["fix/login"],
      current: false,
    });
    expect(one("git push --force-with-lease origin HEAD:refs/heads/fix/login")?.branches).toEqual([
      "fix/login",
    ]);
    expect(one("git push origin +fix/login")?.branches).toEqual(["fix/login"]);
    expect(one("cd ../other && git push origin a b")).toEqual({
      dir: "/p/other",
      branches: ["a", "b"],
      current: false,
    });
    expect(one("git -C /work/x push")?.dir).toBe("/work/x");
    expect(one("git --git-dir=/x/.git push")?.dir).toBeNull();
    expect(pushPlans("git add . && git commit -m 'x' && git push origin fix", ctx)).toHaveLength(1);
    expect(pushPlans("git status", ctx)).toEqual([]);
    expect(pushPlans("git push $(git remote)", ctx)).toBeUndefined();
  });

  it("marks pushes that do more than update named branches", () => {
    for (const command of [
      "git push --all",
      "git push --tags",
      "git push --mirror origin",
      "git push origin --delete fix",
      "git push origin :fix",
      "git push origin v1.0:refs/tags/v1.0",
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push --repo=origin",
    ]) {
      expect(one(command)?.wide, command).toBeDefined();
    }
  });
});

describe("stepsSaidIn (ADR 0064)", () => {
  it("finds the steps the owner's words ask for", () => {
    expect(stepsSaidIn("修好登录超时，做完推上去开个PR")).toEqual(["push", "pull-request"]);
    expect(stepsSaidIn("fix it, push and open a pull request")).toEqual(["push", "pull-request"]);
    expect(stepsSaidIn("改完直接合到 main")).toEqual(["merge"]);
    expect(stepsSaidIn("在 issue 下面回复一下 reviewer")).toEqual(["comment"]);
    expect(stepsSaidIn("发版到 npm")).toEqual(["publish"]);
    expect(stepsSaidIn("部署到测试环境")).toEqual(["deploy"]);
    expect(stepsSaidIn("写好后发邮件给导师")).toEqual(["send"]);
    expect(stepsSaidIn("把要点更新到飞书文档里")).toEqual(["edit"]);
  });

  it("ignores words that only look like a step, and steps the owner refused", () => {
    expect(stepsSaidIn("推荐几个库，推理一下哪个更快")).toEqual([]);
    expect(stepsSaidIn("fix the sprint board in docker")).toEqual([]);
    expect(stepsSaidIn("修好后推上去，不用开 PR，别合并")).toEqual(["push"]);
    expect(stepsSaidIn("don't push yet")).toEqual([]);
    expect(stepsSaidIn("没问题就推上去")).toEqual(["push"]);
    expect(stepsSaidIn("开个合并请求")).toEqual(["pull-request"]);
  });
});
