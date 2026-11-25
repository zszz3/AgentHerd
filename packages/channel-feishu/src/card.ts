import type {
  ItemOption,
  ItemView,
  Locale,
  ReportResult,
  Risk,
  Stage,
  TextTone,
  TextView,
  View,
} from "@agentherd/protocol";
import { DEFAULT_LOCALE } from "@agentherd/protocol";
import { hasHerdUi, herdUiPlain } from "@agentherd/protocol/herd-ui";
import {
  actionRow,
  answerElement,
  collapsiblePanel,
  escapeCodeFence,
  foldedMarkdown,
  markdown,
} from "./card-parts.ts";
import { herdUiElements, withPictures } from "./herd-ui-card.ts";
import { readableMath } from "./math.ts";
import type { CardTexts } from "./texts.ts";
import { CARD_TEXTS } from "./texts.ts";

export { FOLD_CHARS } from "./card-parts.ts";

/** Feishu card header template color for an item's risk level. */
function riskTemplate(risk: Risk): string {
  switch (risk) {
    case "low":
      return "green";
    case "medium":
      return "orange";
    case "high":
      return "red";
  }
}

/** User-facing tag text for an item's risk level. */
function riskLabel(risk: Risk, t: CardTexts): string {
  return t.risk[risk];
}

/** A card header: title, colored template, and a risk tag. */
function itemHeader(
  title: string,
  risk: Risk,
  template: string,
  t: CardTexts,
): Record<string, unknown> {
  return {
    title: { tag: "plain_text", content: title },
    template,
    text_tag_list: [
      {
        tag: "text_tag",
        text: { tag: "plain_text", content: riskLabel(risk, t) },
        color: riskTemplate(risk),
      },
    ],
  };
}

/** A callback button for one item option. */
function itemButton(itemId: string, option: ItemOption): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: option.label },
    type:
      option.action === "allow"
        ? "primary_filled"
        : option.action === "deny"
          ? "danger"
          : "default",
    behaviors: [{ type: "callback", value: { target: itemId, action: option.action } }],
  };
}

function makeCard(
  header: Record<string, unknown> | undefined,
  elements: Record<string, unknown>[],
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { update_multi: true },
    body: { elements },
  };
  if (header !== undefined) {
    card.header = header;
  }
  return card;
}

/** Feishu option color for a board row's stage. */
function stageColor(stage: Stage): string {
  switch (stage) {
    case "queued":
      return "neutral";
    case "working":
      return "blue";
    case "needs-owner":
      return "orange";
    case "stuck":
      return "red";
    case "done":
      return "green";
    case "failed":
      return "red";
  }
}

/** Local-time HH:MM from an ISO timestamp, zero-padded. */
function clock(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Header template color for a report, driven by how the task ended. */
function reportTemplate(result: ReportResult): string {
  switch (result) {
    case "failed":
      return "red";
    case "blocked":
      return "orange";
    case "done":
      return "green";
    case "stopped":
      return "grey";
  }
}

const REPORT_ICON: Record<ReportResult, string> = {
  done: "✅",
  failed: "❌",
  blocked: "⚠️",
  stopped: "⏹",
};

const TONE: Record<TextTone, { icon: string; template: string }> = {
  progress: { icon: "⏳", template: "blue" },
  alarm: { icon: "⚠️", template: "orange" },
  error: { icon: "❌", template: "red" },
};

/**
 * A text's header (ADR 0036): none for the Herder talking; a task's message gets its name with an
 * icon and colour by tone (blue by default); an error without a task gets a red header.
 */
function textHeader(view: TextView, t: CardTexts): Record<string, unknown> | undefined {
  if (view.taskLabel === undefined && view.tone === undefined) return undefined;
  const tone = TONE[view.tone ?? "progress"];
  const title =
    view.taskLabel !== undefined
      ? `${tone.icon} ${view.taskLabel}`
      : (view.title ?? (view.tone === "error" ? t.errorHeader : tone.icon));
  return { title: { tag: "plain_text", content: title }, template: tone.template };
}

/** Buttons in one row. */
function buttonRow(target: string, options: readonly ItemOption[]): Record<string, unknown> {
  return {
    tag: "column_set",
    columns: options.map((option) => ({
      tag: "column",
      width: "auto",
      elements: [itemButton(target, option)],
    })),
  };
}

/** Several approvals on one card (ADR 0056): numbered lines, each with its buttons. */
function renderItemLines(view: ItemView, t: CardTexts): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  for (const line of view.lines ?? []) {
    const task =
      line.taskLabel === undefined ? "" : ` <font color='grey'>· ${line.taskLabel}</font>`;
    elements.push(markdown(`**${line.n}. ${line.title}**${task}`));
    elements.push(markdown(`\`\`\`\n${escapeCodeFence(line.body)}\n\`\`\``));
    if (line.reason !== undefined) {
      elements.push(markdown(`${t.reasonPrefix}<font color='grey'>${line.reason}</font>`));
    }
    if (line.final !== undefined) elements.push(markdown(`**${line.final}**`));
    else elements.push(buttonRow(line.itemId, line.options));
    elements.push({ tag: "hr" });
  }
  if (view.final !== undefined) {
    elements.push(markdown(`**${view.final}**`));
  } else {
    if (view.body !== "") elements.push(markdown(`<font color='grey'>${view.body}</font>`));
    elements.push(buttonRow(view.itemId, view.options));
  }
  return makeCard(
    itemHeader(view.title, view.risk, view.final !== undefined ? "grey" : "orange", t),
    elements,
  );
}

/**
 * Render a channel-neutral view as Feishu Card JSON 2.0. `images` maps the paths of herd-ui
 * pictures already uploaded to their image keys; a picture without one is shown by its path.
 */
export function renderCard(
  view: View,
  locale: Locale = DEFAULT_LOCALE,
  images?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const t = CARD_TEXTS[locale];
  switch (view.kind) {
    case "item": {
      if (view.exactApproval !== undefined) {
        // Use literal text with no line limit and no folding. Cap conservatively before sending.
        if (Buffer.byteLength(view.exactApproval, "utf8") > 12_000 || view.lines !== undefined)
          throw new Error("Exact approval exceeds Feishu card limits");
        const elements: Record<string, unknown>[] = [
          {
            tag: "div",
            text: { tag: "plain_text", content: view.exactApproval },
          },
        ];
        if (view.final !== undefined)
          elements.push({ tag: "div", text: { tag: "plain_text", content: view.final } });
        else elements.push(buttonRow(view.itemId, view.options));
        return makeCard(
          itemHeader(view.title, view.risk, view.final === undefined ? "orange" : "grey", t),
          elements,
        );
      }
      if (view.lines !== undefined) return renderItemLines(view, t);
      const elements: Record<string, unknown>[] = [markdown(`**${view.title}**`)];
      elements.push(markdown(`\`\`\`\n${escapeCodeFence(view.body)}\n\`\`\``));
      if (view.reason !== undefined) {
        elements.push(markdown(`${t.reasonPrefix}<font color='grey'>${view.reason}</font>`));
      }
      if (view.final !== undefined) {
        elements.push(markdown(`**${view.final}**`));
      } else {
        elements.push({
          tag: "column_set",
          columns: view.options.map((option) => ({
            tag: "column",
            width: "auto",
            elements: [itemButton(view.itemId, option)],
          })),
        });
      }
      return makeCard(
        itemHeader(
          t.itemHeader(view.taskLabel),
          view.risk,
          view.final !== undefined ? "grey" : "orange",
          t,
        ),
        elements,
      );
    }
    case "text": {
      // A reply with herd-ui fences is drawn as components (ADR 0074), never folded as a whole.
      const text = withPictures(view.text, images);
      const elements = hasHerdUi(text)
        ? herdUiElements(text, { t, target: view.target, chosen: view.chosen, images })
        : foldedMarkdown(text, t.showAll);
      if (view.options !== undefined && view.target !== undefined) {
        for (const o of view.options) elements.push(actionRow(view.target, o.action, o.label));
      }
      return makeCard(textHeader(view, t), elements);
    }
    case "board": {
      const header = { title: { tag: "plain_text", content: t.boardHeader }, template: "blue" };
      if (view.rows.length === 0) {
        return makeCard(header, [markdown(t.noTasks)]);
      }
      const table: Record<string, unknown> = {
        tag: "table",
        page_size: Math.min(10, view.rows.length),
        row_height: "low",
        freeze_first_column: true,
        header_style: {
          text_align: "left",
          text_size: "normal",
          background_style: "grey",
          text_color: "default",
          bold: true,
          lines: 1,
        },
        columns: [
          { name: "task", display_name: t.columns.task, data_type: "text", width: "auto" },
          { name: "stage", display_name: t.columns.stage, data_type: "options", width: "120px" },
          { name: "project", display_name: t.columns.project, data_type: "text", width: "auto" },
          { name: "agent", display_name: t.columns.agent, data_type: "text", width: "100px" },
          { name: "report", display_name: t.columns.report, data_type: "lark_md", width: "auto" },
          { name: "updated", display_name: t.columns.updated, data_type: "text", width: "90px" },
        ],
        rows: view.rows.map((row) => ({
          task: row.task,
          stage: [{ text: t.stages[row.stage], color: stageColor(row.stage) }],
          project: row.project,
          agent: row.agent,
          report: readableMath(row.lastReport),
          updated: clock(row.updatedAt),
        })),
      };
      return makeCard(header, [table]);
    }
    case "report": {
      // A report has no answer target: choices in its fences are shown as a list.
      const body = withPictures(view.body, images);
      const elements = hasHerdUi(body)
        ? herdUiElements(body, { t, images })
        : foldedMarkdown(body, t.showAll);
      if (view.summarized && view.fullReply !== undefined) {
        const label =
          view.fullReplyBy === undefined ? t.fullReply : t.fullReplyBy(view.fullReplyBy);
        elements.push(collapsiblePanel(label, view.fullReply));
      }
      if (view.automaticDecisions.length > 0) {
        // Folded: the owner sees how many, and opens the list when they care (ADR 0049).
        elements.push(
          collapsiblePanel(
            `${t.automaticDecisions} · ${view.automaticDecisions.length}`,
            view.automaticDecisions.map((decision) => `- ${decision}`).join("\n"),
          ),
        );
      }
      if (view.result !== "done") {
        elements.push(actionRow(view.taskId, "relay", t.relayToTask));
      }
      const header: Record<string, unknown> = {
        title: { tag: "plain_text", content: `${REPORT_ICON[view.result]} ${view.title}` },
        template: reportTemplate(view.result),
      };
      if (view.subtitle !== undefined) {
        header.subtitle = { tag: "plain_text", content: view.subtitle };
      }
      return makeCard(header, elements);
    }
    case "ask": {
      const elements: Record<string, unknown>[] = [markdown(view.text)];
      if (view.final !== undefined) elements.push(markdown(t.askAnswered(view.final)));
      else {
        for (const o of view.options) elements.push(answerElement(view.askId, o.action, o.label));
      }
      return makeCard(
        {
          title: { tag: "plain_text", content: t.askHeader },
          template: view.final !== undefined ? "grey" : "purple",
        },
        elements,
      );
    }
    case "relay": {
      const elements: Record<string, unknown>[] = [];
      if (view.active) {
        elements.push(markdown(t.relayActive(view.taskLabel)));
        elements.push(actionRow(view.taskId, "end-relay", t.endRelay));
      } else {
        elements.push(markdown(t.backToHerder));
      }
      return makeCard(undefined, elements);
    }
  }
}

/**
 * Render a text view as a plain line, e.g. "[label] text". Herd-ui fences are written as
 * Markdown, so a plain message never shows their JSON (ADR 0074).
 */
export function renderText(view: TextView): string {
  const text = herdUiPlain(view.text);
  if (view.taskLabel !== undefined) {
    return `[${view.taskLabel}] ${text}`;
  }
  return text;
}
