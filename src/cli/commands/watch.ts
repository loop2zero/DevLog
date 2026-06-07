import { startWatching } from "../../core/linear/wiring";

export async function watchCommand(): Promise<void> {
  console.log("devlog watch — polling Linear (Ctrl-C to stop)");
  const handles = await startWatching();
  process.on("SIGINT", () => {
    handles.forEach((h) => h.stop());
    process.exit(0);
  });
  await new Promise(() => {});
}
