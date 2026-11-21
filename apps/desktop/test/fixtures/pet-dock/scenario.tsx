import { createRoot } from "react-dom/client";
import { Pet } from "../../../src/renderer/src/pet/Pet";
import { hitPetRegion, type PetBridge, type PetPose } from "../../../src/shared/bridge";
import "../../../src/renderer/src/pet/pet.css";

let rendererError: string | undefined;
window.addEventListener("error", (event) => {
  rendererError = event.message;
});

const noop = () => {};
let report: Parameters<PetBridge["resize"]>;
let pose: (value: PetPose) => void;
Object.assign(window, {
  agentherd: {
    host: {
      pet: async () => ({
        connected: true,
        history: [],
        pending: [{ target: "open", title: "Review request", body: "Check it", options: [] }],
      }),
      tasks: async () => ({
        tasks: [
          {
            id: "work",
            title: "Working task",
            stage: "working",
            lastReport: "",
            startedAt: new Date().toISOString(),
          },
        ],
      }),
      status: async () => ({ pet: { figure: "claude" } }),
    },
    pet: {
      onMouseLeave: () => noop,
      resize: (...args: Parameters<PetBridge["resize"]>) => {
        report = args;
      },
      interacting: noop,
      onPose: (listener: typeof pose) => {
        pose = listener;
        return noop;
      },
    },
    onEvent: () => noop,
    onConnection: () => noop,
  },
});

const until = async (check: () => unknown, step: string) => {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (rendererError) throw new Error(rendererError);
    if (Date.now() > deadline) throw new Error(`Docked pet scenario timed out: ${step}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function clickDocked(side: "left" | "right", selector: string, tab: string) {
  pose({ side, pose: "grip", animate: false });
  await until(
    () => document.querySelector(`[data-grip="${side}"] ${selector}`) && report?.[3],
    `show ${side} ${selector}`,
  );
  const stage = document.querySelector<HTMLElement>(".pet-root");
  const control = stage?.querySelector<HTMLButtonElement>(selector);
  if (!stage || !control) throw new Error(`Missing ${selector}`);
  const rect = control.getBoundingClientRect();
  const bounds = stage.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const [width, height, , regions] = report;
  if (
    document.elementFromPoint(x, y) !== control ||
    !hitPetRegion(x - bounds.left, y - bounds.top, { width, height }, regions ?? [])
  ) {
    throw new Error(`${side} ${selector} does not receive clicks in the grip pose`);
  }
  control.click();
  await until(() => document.querySelector(".pet-bubble"), `open ${tab}`);
  if (localStorage.getItem("agentherd.pet.tab") !== tab) throw new Error(`Expected ${tab} to open`);
}

Object.assign(window, {
  runDockScenario: async () => {
    for (const side of ["left", "right"] as const) {
      for (const [selector, tab] of [
        [".pet-dot-task", "tasks"],
        [".pet-badge", "cards"],
      ]) {
        localStorage.clear();
        const container = document.getElementById("root");
        if (!container) throw new Error("Missing pet root");
        const root = createRoot(container);
        root.render(<Pet />);
        await until(() => document.querySelector(selector), `render ${selector}`);
        await clickDocked(side, selector, tab);
        root.unmount();
      }
    }
    return true;
  },
});
