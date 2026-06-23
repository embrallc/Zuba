import { useAppStore } from "../appStore";
import WalkthroughEditor from "../walkthrough/WalkthroughEditor";
import ReportEditor from "./ReportEditor";

// Thin shell: pick the active designer. Both are self-contained (own store,
// boot, autosave, keyboard) and only the active one is mounted.
export default function App() {
  const mode = useAppStore((s) => s.mode);
  return mode === "walkthrough" ? <WalkthroughEditor /> : <ReportEditor />;
}
