/**
 * Workbench render worker (invariant I2, gate #4). Owns an OffscreenCanvas transferred
 * from the main thread and draws the logic-analyzer waveform entirely off the main
 * thread, so the UI stays ≥30 FPS no matter how busy the simulation is. It receives
 * pin samples (small messages) and renders on its own ~60 Hz loop; the main thread
 * never touches the hot pixels.
 */
import { LogicAnalyzer, renderLogicAnalyzer } from '@sparklab/workbench';

type InMessage =
  | { type: 'init'; canvas: OffscreenCanvas; windowMs?: number }
  | { type: 'sample'; name: string; tNs: number; value: number }
  | { type: 'stop' };

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvas: OffscreenCanvas | null = null;
const analyzer = new LogicAnalyzer();
let latestNs = 0;
let windowNs = 2_000_000_000; // 2s of virtual time shown
let frames = 0;
let running = false;

function loop(): void {
  if (!running || !ctx || !canvas) return;
  const start = Math.max(0, latestNs - windowNs);
  renderLogicAnalyzer(
    ctx as unknown as import('@sparklab/workbench').Canvas2D,
    analyzer.channels(),
    { startNs: start, endNs: latestNs },
    canvas.width,
  );
  frames++;
  if (frames % 10 === 0) (postMessage as (m: unknown) => void)({ type: 'frames', frames });
  setTimeout(loop, 16); // ~60 fps; dedicated workers have no requestAnimationFrame
}

self.onmessage = (e: MessageEvent<InMessage>): void => {
  const msg = e.data;
  if (msg.type === 'init') {
    canvas = msg.canvas;
    ctx = canvas.getContext('2d');
    if (msg.windowMs) windowNs = msg.windowMs * 1e6;
    running = true;
    loop();
  } else if (msg.type === 'sample') {
    latestNs = Math.max(latestNs, msg.tNs);
    analyzer.record(msg.name, msg.tNs, msg.value);
  } else if (msg.type === 'stop') {
    running = false;
  }
};
