import { createRoot } from "react-dom/client";
import { MijiaControls } from "../../src/renderer/src/components/MijiaControls.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing fictional fixture root");
createRoot(root).render(<MijiaControls bridge={window.agentherd} />);
