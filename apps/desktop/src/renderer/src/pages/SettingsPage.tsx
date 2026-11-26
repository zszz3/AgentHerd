// 设置: the Feishu channel, how approvals work, font size, the desktop pet, keep awake, the first run, and where
// AgentHerd keeps its files. How the Herder talks is on the 主管 page; the owner's apps and
// platforms are on the 应用连接 page.

import type { PetFigure, PetSettings, SettingsPatch } from "@agentherd/host/api";
import {
  Bell,
  BellOff,
  Check,
  Eye,
  FolderOpen,
  Hand,
  Info,
  Keyboard,
  Lightbulb,
  Maximize2,
  Moon,
  MoonStar,
  Palette,
  PanelRightClose,
  PawPrint,
  Pin,
  Rocket,
  SunMoon,
  Type,
  Volume2,
  Zap,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { isQuiet, quietLine, snoozeUntil } from "../../../shared/pet-notify";
import { type ShortcutState, shortcutLabel, shortcutOf } from "../../../shared/pet-shortcuts";
import { THEMES, type Theme } from "../../../shared/theme";
import { DataDirectorySettings } from "../components/DataDirectory";
import { FeishuSection } from "../components/FeishuSection";
import { FigurePicker } from "../components/FigurePicker";
import {
  Button,
  Group,
  IconTile,
  inputClass,
  Row,
  Section,
  Segmented,
  Switch,
} from "../components/ui";
import { FONT_SCALES, setFontScale, useFontScale } from "../font-scale";
import { isMac } from "../platform";
import { call, type Mode, useApp } from "../store";

const MODES: { mode: Mode; title: string; hint: string; icon: typeof Eye }[] = [
  {
    mode: "observe",
    title: "只观察",
    hint: "什么都不自动放行，每个请求都发到飞书等你批准",
    icon: Eye,
  },
  {
    mode: "assist",
    title: "协助",
    hint: "本机上的操作自动放行；推送、开 PR、发消息、大量删除等你批准",
    icon: Hand,
  },
];

export function SettingsPage() {
  const status = useApp((s) => s.status);
  const openFirstRun = useApp((s) => s.openFirstRun);
  const [busy, setBusy] = useState(false);
  const fontScale = useFontScale();

  const update = async (patch: SettingsPatch) => {
    setBusy(true);
    const next = await call((h) => h.updateSettings(patch));
    if (next !== undefined) useApp.setState({ status: next });
    setBusy(false);
  };

  if (status === undefined) return null;

  return (
    <div className="flex flex-col gap-7">
      <FeishuSection />

      <Section title="审批方式">
        <Group>
          {MODES.map(({ mode, title, hint, icon: Icon }) => {
            const active = status.mode === mode;
            return (
              <label key={mode} className="block cursor-pointer hover:bg-hover">
                <input
                  type="radio"
                  name="mode"
                  className="peer sr-only"
                  checked={active}
                  disabled={busy}
                  onChange={() => void update({ mode })}
                />
                <Row
                  className="peer-focus-visible:bg-hover"
                  icon={
                    <IconTile tone={active ? "blue" : "gray"}>
                      <Icon size={15} strokeWidth={1.75} />
                    </IconTile>
                  }
                  title={title}
                  description={hint}
                  trailing={active ? <Check size={16} className="text-accent-text" /> : undefined}
                />
              </label>
            );
          })}
          {!MODES.some((m) => m.mode === status.mode) && (
            <div className="px-4 py-2.5 text-ink-muted text-sm">当前模式：{status.mode}</div>
          )}
        </Group>
      </Section>

      <Section title="外观">
        <Group>
          <ThemeRow />
          <Row
            icon={
              <IconTile>
                <Type size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="字体大小"
            description="整个界面的文字大小，只对这台电脑生效"
            trailing={
              <Segmented
                label="字体大小"
                options={FONT_SCALES}
                value={fontScale}
                onChange={setFontScale}
              />
            }
          />
        </Group>
      </Section>

      <Section title="桌宠">
        <Group>
          <Row
            icon={
              <IconTile tone="blue">
                <PawPrint size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="显示桌宠"
            description="浮在桌面上，飞书收到的消息她也会说；点她就能跟主管说话、直接批准"
            trailing={
              <Switch
                label="显示桌宠"
                checked={status.pet?.on ?? false}
                disabled={busy || status.pet === undefined}
                onChange={(on) => void update({ pet: { on } })}
              />
            }
          />
          <Row
            icon={
              <IconTile>
                <Palette size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="形象"
            description="点一个换上；下面写着它是谁画的、从哪来"
          />
          <div className="px-4 pt-1 pb-4">
            <FigurePicker
              figure={status.pet?.figure ?? "deepseek"}
              disabled={busy || status.pet === undefined}
              pick={(figure: PetFigure) => void update({ pet: { figure } })}
            />
          </div>
          {status.pet?.suggest !== undefined && (
            <Row
              icon={
                <IconTile>
                  <Lightbulb size={15} strokeWidth={1.75} />
                </IconTile>
              }
              title="猜你下一句"
              description="主管回完话，在输入框里灰着显示你可能想说的下一句，按 Tab 填进去；每次回复多一次很小的模型调用"
              trailing={
                <Switch
                  label="猜你下一句"
                  checked={status.pet.suggest}
                  disabled={busy}
                  onChange={(suggest) => void update({ pet: { suggest } })}
                />
              }
            />
          )}
        </Group>
        <PetQuiet pet={status.pet} busy={busy} update={update} />
        <PetPlace pet={status.pet} busy={busy} update={update} />
        <PetKeys pet={status.pet} busy={busy} update={update} />
      </Section>

      <Section title="电源">
        <Group>
          <Row
            icon={
              <IconTile>
                <MoonStar size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="防止休眠"
            description={
              isMac()
                ? "有任务在跑时让电脑保持唤醒，合上盖子也能继续"
                : "有任务在跑时阻止电脑空闲自动休眠，关闭窗口后在托盘保持连接"
            }
            trailing={
              <Switch
                label="防止休眠"
                checked={status.keepAwake}
                disabled={busy}
                onChange={(keepAwake) => void update({ keepAwake })}
              />
            }
          />
        </Group>
      </Section>

      <Section title="关于">
        <Group>
          <Row
            icon={
              <IconTile>
                <Rocket size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="重新运行引导"
            description="一步步绑定飞书、添加模型服务、给主管选模型"
            trailing={<Button onClick={openFirstRun}>打开引导</Button>}
          />
          <Row
            icon={
              <IconTile>
                <FolderOpen size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="数据目录"
            trailing={<DataDirectorySettings home={status.home} />}
          />
          <Row
            icon={
              <IconTile>
                <Info size={15} strokeWidth={1.75} />
              </IconTile>
            }
            title="版本"
            trailing={
              <span className="selectable font-mono text-ink-muted text-sm">{status.version}</span>
            }
          />
        </Group>
      </Section>
    </div>
  );
}

/** Default quiet hours when the owner turns them on (ADR 0079). */
const QUIET_DEFAULT = "22:00-08:00";

/** Notifications, sound, quiet hours and a snooze for the pet (ADR 0079). */
function PetQuiet({
  pet,
  busy,
  update,
}: {
  pet: PetSettings | undefined;
  busy: boolean;
  update: (patch: SettingsPatch) => Promise<void>;
}) {
  // An older host has no notification settings.
  if (pet?.notify === undefined) return null;
  const now = new Date();
  const [from = "22:00", to = "08:00"] = (pet.quietHours || QUIET_DEFAULT).split("-");
  const snoozed = pet.quietUntil !== "" && Date.parse(pet.quietUntil) > now.getTime();
  const setHours = (a: string, b: string) => {
    if (/^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b))
      void update({ pet: { quietHours: `${a}-${b}` } });
  };
  return (
    <Group className="mt-3">
      <Row
        icon={
          <IconTile tone="blue">
            <Bell size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="系统通知"
        description="要你确认的事、主管问你的话和任务结果，桌宠和 App 不在眼前时也弹通知；点通知就打开桌宠"
        trailing={
          <Switch
            label="系统通知"
            checked={pet.notify}
            disabled={busy}
            onChange={(notify) => void update({ pet: { notify } })}
          />
        }
      />
      <Row
        icon={
          <IconTile>
            <Volume2 size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="提示音"
        description="要你确认、主管提问和没做成的任务会响；做完的任务只弹不响"
        trailing={
          <Switch
            label="提示音"
            checked={pet.sound}
            disabled={busy || !pet.notify}
            onChange={(sound) => void update({ pet: { sound } })}
          />
        }
      />
      <Row
        icon={
          <IconTile>
            <Moon size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="免打扰时段"
        description="这段时间不弹通知、不响，桌宠也不自己打开对话；事情照样记着，点开就能看"
        trailing={
          <>
            {pet.quietHours !== "" && (
              <span className="flex items-center gap-1 text-sm text-ink-muted">
                <input
                  type="time"
                  aria-label="免打扰开始"
                  className={`${inputClass} w-[92px]`}
                  value={from}
                  disabled={busy}
                  onChange={(e) => setHours(e.target.value, to)}
                />
                到
                <input
                  type="time"
                  aria-label="免打扰结束"
                  className={`${inputClass} w-[92px]`}
                  value={to}
                  disabled={busy}
                  onChange={(e) => setHours(from, e.target.value)}
                />
              </span>
            )}
            <Switch
              label="免打扰时段"
              checked={pet.quietHours !== ""}
              disabled={busy}
              onChange={(on) => void update({ pet: { quietHours: on ? QUIET_DEFAULT : "" } })}
            />
          </>
        }
      />
      <Row
        icon={
          <IconTile>
            <BellOff size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="暂停提醒"
        description={
          snoozed
            ? `${quietLine(pet, now) ?? ""}，到点自动恢复`
            : isQuiet(pet, now)
              ? "现在在免打扰时段里"
              : "临时安静一会儿；菜单栏的图标里也能点"
        }
        trailing={
          snoozed ? (
            <Button disabled={busy} onClick={() => void update({ pet: { quietUntil: "" } })}>
              恢复提醒
            </Button>
          ) : (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void update({ pet: { quietUntil: snoozeUntil("hour", new Date()) } })
                }
              >
                1 小时
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void update({ pet: { quietUntil: snoozeUntil("morning", new Date()) } })
                }
              >
                到明早 8 点
              </Button>
            </>
          )
        }
      />
    </Group>
  );
}

const ON_TOP_OPTIONS = [
  { value: "always", label: "一直" },
  { value: "busy", label: "有事时" },
] as const;

/** Where the pet floats (ADR 0080): on top always or only when busy, over full screen, edges. */
function PetPlace({
  pet,
  busy,
  update,
}: {
  pet: PetSettings | undefined;
  busy: boolean;
  update: (patch: SettingsPatch) => Promise<void>;
}) {
  // An older host has no placement settings.
  if (pet?.onTop === undefined) return null;
  return (
    <Group className="mt-3">
      <Row
        icon={
          <IconTile>
            <Pin size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="浮在最上面"
        description="选「有事时」：要你确认、来了新消息或对话开着时才浮在最上面，平时和别的窗口一样会被盖住"
        trailing={
          <Segmented
            label="浮在最上面"
            options={ON_TOP_OPTIONS}
            value={pet.onTop}
            onChange={(onTop) => void update({ pet: { onTop } })}
          />
        }
      />
      {isMac() && (
        <Row
          icon={
            <IconTile>
              <Maximize2 size={15} strokeWidth={1.75} />
            </IconTile>
          }
          title="全屏应用上也显示"
          description="关着时，别的应用全屏（看视频、演示）就看不到桌宠，通知照常"
          trailing={
            <Switch
              label="全屏应用上也显示"
              checked={pet.overFullscreen}
              disabled={busy}
              onChange={(overFullscreen) => void update({ pet: { overFullscreen } })}
            />
          }
        />
      )}
      <Row
        icon={
          <IconTile>
            <PanelRightClose size={15} strokeWidth={1.75} />
          </IconTile>
        }
        title="藏到屏幕边上"
        description="把桌宠拖出屏幕左边或右边一截再松手，它就藏在边上只露一点；鼠标移过去就出来，有新消息也会出来"
      />
    </Group>
  );
}

type KeyName = "talkKey" | "approveKey";

/** The pet's two global shortcuts (ADR 0080): press 设置 and then the keys; 关闭 turns one off. */
function PetKeys({
  pet,
  busy,
  update,
}: {
  pet: PetSettings | undefined;
  busy: boolean;
  update: (patch: SettingsPatch) => Promise<void>;
}) {
  const [recording, setRecording] = useState<KeyName>();
  const [state, setState] = useState<ShortcutState>();
  const shortcuts = window.agentherd.shortcuts;
  useEffect(() => {
    if (shortcuts === undefined) return;
    void shortcuts.state().then(setState);
    return shortcuts.onState(setState);
  }, [shortcuts]);
  // While recording, the old shortcuts let go so their keys reach this page.
  useEffect(() => {
    if (shortcuts === undefined || recording === undefined) return;
    shortcuts.pause(true);
    return () => shortcuts.pause(false);
  }, [shortcuts, recording]);
  // An older host has no shortcuts; an older app cannot take them.
  if (pet?.talkKey === undefined || shortcuts === undefined) return null;
  const mac = isMac();

  const onKey = (name: KeyName) => (e: KeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(undefined);
      return;
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === "Backspace" || e.key === "Delete")) {
      setRecording(undefined);
      void update({ pet: { [name]: "" } });
      return;
    }
    const accel = shortcutOf(e, mac);
    if (accel === undefined) return;
    setRecording(undefined);
    void update({ pet: { [name]: accel } });
  };

  const row = (name: KeyName, title: string, description: string, icon: ReactNode) => {
    const value = pet[name];
    const which = name === "talkKey" ? "talk" : "approve";
    const taken = value !== "" && state?.[which] === "taken";
    const on = recording === name;
    return (
      <Row
        icon={icon}
        title={title}
        description={taken ? "这个组合键被别的应用占用了，换一个吧" : description}
        trailing={
          <>
            <Button
              disabled={busy}
              className={on ? "ring-2 ring-accent" : ""}
              aria-label={`${title}的快捷键`}
              onClick={() => setRecording(on ? undefined : name)}
              onKeyDown={on ? onKey(name) : undefined}
              onBlur={() => on && setRecording(undefined)}
            >
              {on ? "按下组合键…" : value === "" ? "未设置" : shortcutLabel(value, mac)}
            </Button>
            {value !== "" && !on && (
              <Button disabled={busy} onClick={() => void update({ pet: { [name]: "" } })}>
                关闭
              </Button>
            )}
          </>
        }
      />
    );
  };

  return (
    <Group className="mt-3">
      {row(
        "talkKey",
        "和主管说话",
        "在哪个应用里按都行：打开对话并聚焦输入框，再按一次收起",
        <IconTile>
          <Keyboard size={15} strokeWidth={1.75} />
        </IconTile>,
      )}
      {row(
        "approveKey",
        "同意最早的那件事",
        "按一下，桌宠指出最早等你同意的那件；5 秒内再按一下就同意它，Esc 取消",
        <IconTile>
          <Zap size={15} strokeWidth={1.75} />
        </IconTile>,
      )}
    </Group>
  );
}

/** 颜色: light, dark or the system's, applied by main to every window (shared/theme.ts). */
function ThemeRow() {
  const bridge = window.agentherd.theme;
  const [theme, setTheme] = useState<Theme | undefined>();
  useEffect(() => {
    void bridge?.get().then(setTheme);
  }, [bridge]);
  if (bridge === undefined || theme === undefined) return null;
  return (
    <Row
      icon={
        <IconTile>
          <SunMoon size={15} strokeWidth={1.75} />
        </IconTile>
      }
      title="颜色"
      description="浅色或深色；跟随系统时，系统切换它也跟着换。桌宠一起变"
      trailing={
        <Segmented
          label="颜色"
          options={THEMES}
          value={theme}
          onChange={(next) => {
            setTheme(next);
            void bridge.set(next);
          }}
        />
      }
    />
  );
}
