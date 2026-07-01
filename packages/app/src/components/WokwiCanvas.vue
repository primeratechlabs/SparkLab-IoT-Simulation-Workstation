<script setup lang="ts">
/**
 * Wokwi circuit canvas — the "Trình nối mạch" surface. Renders the board + parts as vendored
 * @wokwi/elements (no CDN), with the palette driven by the @sparklab/schematic catalog. Presentation
 * only: all model/geometry/drag/wire logic lives in useCircuitCanvas.
 *
 * Interaction (ported from the design): click a pin → a dashed rubber-band trails the cursor → click
 * empty canvas to drop a bend point → click the target pin to commit. Wires colour by signal and are
 * click-to-delete. A selected part shows a floating toolbar (rotate 30° / flip / LED colour / delete);
 * Esc cancels a wire, Delete removes the selected part. The LED reflects the running firmware.
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import '@wokwi/elements';
import '../lib/breadboard-element'; // vendored <sparklab-breadboard> (wokwi has none) — registers on import
import '../lib/water-sensor-element'; // vendored <sparklab-water-sensor> (wokwi has none) — registers on import
import {
  COMPONENT_CATALOG,
  wokwiTagFor,
  wokwiBoardTagFor,
  isAnalogSensor,
  interactionOf,
  LED_COLORS,
  documentToNetlist,
  componentReadiness,
  type ComponentCatalogEntry,
  type PropValue,
  type CircuitDocument,
  type DeviceReflection,
} from '@sparklab/schematic';
import {
  useCircuitCanvas,
  BOARD_CID,
  WIRE_COLORS,
  type Placed,
  type CanvasWire,
} from '../composables/useCircuitCanvas';
import { projectCanvas, type UnmappedEndpoint } from '../lib/canvas-to-document';
import type { SavedCanvas } from '../lib/persist';
import PartInspector from './PartInspector.vue';

const props = defineProps<{
  boardId: string;
  ledOn: boolean;
  /** Every driven digital pin → level, from the emulator. Components reflect the pin they are wired to. */
  pins: Record<number, 0 | 1>;
  running: boolean;
  /** Drawn-device visible state by component id (servo angle, LCD text, …) from the device-runtime. */
  devices?: Record<string, DeviceReflection>;
  /** PWM duty 0..1 by pin/channel (LED brightness when an SoC drives a pin via ledcWrite). */
  pwmDuty?: Record<number, number>;
  /** Restored circuit snapshot (autosave) — applied once on mount so a reload keeps the drawn circuit. */
  initialCanvas?: SavedCanvas | null;
}>();

const canvasEl = ref<HTMLElement | null>(null);
const drawerOpen = ref(false);
const boardTag = computed(() => wokwiBoardTagFor(props.boardId));

// The on-board LED a board exposes — element property + the firmware pin that drives it (a real
// hardware fact). The "L" LED is hardwired to D13 on the Uno and to GPIO2 on the ESP32 DevKit.
const ONBOARD_LED: Record<string, { prop: string; pin: number }> = {
  'arduino-uno': { prop: 'led13', pin: 13 },
  'esp32-devkit': { prop: 'led1', pin: 2 },
};
const boardBindings = computed<Record<string, unknown>>(() => {
  const out: Record<string, unknown> = { ledPower: props.running };
  const led = ONBOARD_LED[props.boardId];
  if (led) out[led.prop] = props.running && props.pins[led.pin] === 1;
  return out;
});

const canvas = useCircuitCanvas(
  canvasEl,
  computed(() => props.boardId),
);
const {
  placed,
  pinDots,
  wirePaths,
  pendingPin,
  pendingSolid,
  rubberPath,
  pendingPoints,
  pendingName,
  hoverLabel,
  selected,
  wireCount,
  boardLayout,
  breadboardStrips,
  zoom,
} = canvas;

// Breadboards render first (lowest z) so any part plugged into one sits ON TOP of it, never hidden under
// it — regardless of the order the user added them. Relative order within each group is preserved.
const renderParts = computed(() => {
  const boards = placed.value.filter((p) => p.type === 'breadboard');
  const rest = placed.value.filter((p) => p.type !== 'breadboard');
  return [...boards, ...rest];
});
// Pin dots split across two layers: breadboard holes sit BELOW the parts (a plugged-in part covers the
// holes under it); board + part pins stay on the top overlay (always visible + clickable).
const partPinDots = computed(() => pinDots.value.filter((d) => !d.bb));
const breadboardPinDots = computed(() => pinDots.value.filter((d) => d.bb));

/** Palette: catalog parts that have a wokwi element. */
const palette = computed<ComponentCatalogEntry[]>(() =>
  Object.values(COMPONENT_CATALOG).filter((e) => wokwiTagFor(e.type) !== undefined),
);
// Drawer search (Issue 16): the catalog has grown to 30+ parts, so let the user filter by name/type/tag
// instead of scrolling a long ungrouped list.
const paletteQuery = ref('');
const filteredPalette = computed<ComponentCatalogEntry[]>(() => {
  const q = paletteQuery.value.trim().toLowerCase();
  if (!q) return palette.value;
  return palette.value.filter(
    (e) =>
      e.displayName.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
});

function addPart(entry: ComponentCatalogEntry): void {
  const tag = wokwiTagFor(entry.type);
  if (!tag) return;
  canvas.addPart(entry.type, tag);
  drawerOpen.value = false;
  paletteQuery.value = ''; // reset the search so the next drawer open shows the full library (Issue 16)
  void nextTick(() => void canvas.refreshAll());
}

/** True iff the firmware is running and the given digital pin is currently HIGH. */
function pinHigh(pin: number | undefined): boolean {
  return props.running && pin !== undefined && props.pins[pin] === 1;
}
/**
 * Props bound to each wokwi element by type, driven by the REAL emulated pin state. Each output part
 * reflects the firmware pin it is actually wired to (net-traced from the drawn wires) — an unwired
 * part stays inert. No sketch- or device-specific special-casing.
 */
function propsFor(p: Placed): Record<string, unknown> {
  switch (p.type) {
    case 'led': {
      // brightness: PWM duty from the device runtime (AVR Led measures it; SoC ledcWrite via pwmDuty),
      // so analogWrite/fade dims the LED instead of a binary on/off (CMB-04). Steady HIGH = full bright.
      const pin = canvas.controllingDigital(p.cid);
      const on = pinHigh(pin);
      const duty =
        (props.devices?.[p.cid]?.dutyPct as number | undefined) ??
        (pin !== undefined ? props.pwmDuty?.[pin] : undefined);
      const brightness = typeof duty === 'number' ? duty : on ? 1 : 0;
      return { value: on || brightness > 0, brightness, color: p.props.color ?? 'red' };
    }
    case 'buzzer':
      return { hasSignal: pinHigh(canvas.controllingDigital(p.cid)) };
    case 'rgb-led': {
      const chan = (name: string): number =>
        pinHigh(canvas.resolvePin(p.cid, name)?.digital) ? 255 : 0;
      return { ledRed: chan('R'), ledGreen: chan('G'), ledBlue: chan('B') };
    }
    case 'resistor':
      return { value: String(p.props.ohms ?? 220) }; // the catalog Ω drives the colour bands
    case 'lcd-i2c':
      // render the 4 I²C pins (GND/VCC/SDA/SCL) + the text the firmware actually drove onto the LCD.
      return { pins: 'i2c', text: (props.devices?.[p.cid]?.text as string) ?? '' };
    case 'servo': {
      // the shaft angle the firmware commanded (decoded from the PWM pulse width), -1 → rest at 0°.
      const a = props.devices?.[p.cid]?.angleDeg;
      return { angle: typeof a === 'number' && a >= 0 ? a : 0 };
    }
    case 'water-level':
      // the water level the probe is submerged in (a scene parameter, like HC-SR04 distance) drives the fill.
      return { level: Number(p.props.level ?? 40) };
    default:
      return {};
  }
}
function partTransform(p: Placed): string {
  return `rotate(${p.rot}deg) scaleX(${p.flip ? -1 : 1})`;
}
/**
 * Whether the wokwi element receives pointer events. A BUTTON is ALWAYS live so it can be pressed (and
 * give tactile feedback) even before Run — `armDrag` keeps it draggable. Every other part is pointer-
 * transparent in edit mode so a drag is grabbed cleanly by the wrapper, and live while running (a pot
 * turns; the rest just stay selectable). `undefined` = inherit (auto).
 */
function hostPointerEvents(p: Placed): 'none' | undefined {
  if (interactionOf(p.type) === 'button') return undefined;
  return props.running ? undefined : 'none';
}
function boardTransform(): string {
  return `rotate(${canvas.boardRot.value}deg)`;
}
/** The selected wire's render info (for its floating colour toolbar), or null. */
const selectedWireInfo = computed(() => wirePaths.value.find((w) => w.selected) ?? null);

// ── inputs: placed buttons/pots/sensors drive the firmware via the pin they are wired to ──────────
const emit = defineEmits<{
  button: [pin: number, pressed: boolean];
  pot: [channel: number, raw: number];
  circuit: [doc: CircuitDocument];
  /** Wire endpoints that didn't reconcile to a catalog pin (AUD-003) — drawn but NOT in the runtime netlist. */
  unmapped: [endpoints: UnmappedEndpoint[]];
  'device-prop': [cid: string, name: string, value: PropValue];
  /** Raw canvas snapshot for autosave (placed parts + wires + board pose). */
  state: [snap: SavedCanvas];
}>();
// Autosave: emit the raw editor state whenever the circuit changes, so the parent can persist + restore it.
const canvasSnapshot = computed<SavedCanvas>(() => ({
  placed: placed.value,
  wires: canvas.wires.value,
  boardPos: { x: canvas.boardPos.x, y: canvas.boardPos.y },
  boardRot: canvas.boardRot.value,
}));
watch(canvasSnapshot, (s) => emit('state', s), { deep: true });
// Which parts accept live input + how is DECLARED ONCE in the catalog (`interaction` per type), so a new
// device can never silently miss its inspector control: `isLiveOperated` = press/turn its own wokwi
// element; `isAnalogSensor` = external stimulus slider. Gas/flame are deliberately neither — they carry a
// `level` (0–100%) prop applied live via the device-runtime, so Run never re-seeds them to a default that
// would clobber the configured level (the multi-device UX risk).
/**
 * How a placed part responds to a pointerdown:
 *  - BUTTON: operated by a STATIONARY press, which must reach its wokwi element — so we never capture the
 *    pointer up-front; `armDrag` defers the part-drag until the pointer travels past a threshold (a press
 *    is a press, a press-and-move drags). The button is therefore pressable in BOTH edit and run mode (no
 *    "dead button" before Run) yet still draggable.
 *  - POT (while running): operated by TURNING its knob (a drag on the element), so the part itself must
 *    NOT move — select only, let the wokwi element consume the drag.
 *  - everything else (and the pot in edit mode): drag the part immediately.
 */
function onPartDown(e: PointerEvent, p: Placed): void {
  const kind = interactionOf(p.type);
  if (kind === 'button') {
    canvas.armDrag(e, p.cid);
    return;
  }
  if (props.running && kind === 'pot') {
    canvas.selectPart(p.cid);
    return;
  }
  canvas.startDrag(e, p.cid);
}
/** Board body pointerdown: select + drag the MCU (unless a wire is in flight — then leave it alone). */
function onBoardDown(e: PointerEvent): void {
  e.stopPropagation(); // don't bubble to onBgDown (which would immediately deselect)
  if (pendingPin.value) return;
  canvas.startDrag(e, BOARD_CID);
}
function onButton(p: Placed, pressed: boolean): void {
  const pin = canvas.controllingDigital(p.cid);
  if (pin !== undefined) emit('button', pin, pressed);
}
function onPot(p: Placed, e: Event): void {
  const channel = canvas.controllingAnalog(p.cid);
  if (channel !== undefined) emit('pot', channel, Math.round((e as InputEvent).detail));
}
/** The selected part (its floating toolbar + inspector attach to it). */
const selectedPart = computed<Placed | null>(
  () => placed.value.find((p) => p.cid === selected.value) ?? null,
);

// ── inspector (per-part editable attributes) + analog-sensor stimulus ─────────────────────────────
function onProp(name: string, value: PropValue): void {
  if (!selected.value) return;
  canvas.setProp(selected.value, name, value);
  // While running, push the edit to the live device too (e.g. toggle PIR motion / set a sensor level)
  // so the sketch reacts immediately without a re-run.
  if (props.running) emit('device-prop', selected.value, name, value);
}
/** Drag the sensor stimulus → inject a raw ADC reading into the firmware on its wired channel. */
function onStim(raw: number): void {
  const p = selectedPart.value;
  if (!p) return;
  canvas.setProp(p.cid, '_adc', raw);
  const channel = canvas.controllingAnalog(p.cid);
  if (channel !== undefined) emit('pot', channel, raw);
}
/** The ADC channel a selected analog sensor feeds (for its stimulus slider), or undefined. */
const selectedAnalogChannel = computed<number | undefined>(() => {
  const p = selectedPart.value;
  return p && isAnalogSensor(p.type) ? canvas.controllingAnalog(p.cid) : undefined;
});
// Run the schematic ERC truth engine on a CircuitDocument derived from the canvas (P1-5): the product
// consumes the SAME engine the headless layer does, for findings the canvas resolver doesn't compute
// (no series resistor, I²C address conflict/no-bus, power short, floating input).
const ERC_VI: Record<string, string> = {
  'led-no-resistor': 'LED chưa có điện trở nối tiếp (dễ quá dòng)',
  'i2c-address-conflict': 'Trùng địa chỉ I²C trên cùng bus',
  'i2c-no-bus': 'Thiết bị I²C chưa nối bus (SDA/SCL)',
  'power-short': 'Chập nguồn (VCC ↔ GND)',
  'floating-input': 'Chân input thả nổi (thiếu nguồn kéo)',
  'over-voltage': 'Quá áp: GPIO 3.3V nối vào rail 5V',
};
/** The schematic CircuitDocument derived from the canvas — the single input to the truth engine AND
 *  (now) the device-runtime: emit it to the parent so a Run binds the drawn devices to the firmware. */
const projection = computed(() => projectCanvas(placed.value, canvas.wires.value, props.boardId));
const derivedDoc = computed(() => projection.value.doc);
// AUD-003: wires whose endpoints didn't reconcile to a catalog pin are NOT in the runtime netlist — surface
// them instead of dropping silently, and tell the parent the drawn circuit ≠ what runs.
const unmappedWires = computed(() => projection.value.unmapped);
watch(derivedDoc, (d) => emit('circuit', d), { immediate: true });
watch(unmappedWires, (u) => emit('unmapped', u), { immediate: true });
const engineFindings = computed(() => {
  try {
    return documentToNetlist(derivedDoc.value).erc;
  } catch {
    return [];
  }
});
/** Per-component electrical readiness from the engine (covers EVERY part type, not just the canvas rules). */
const readiness = computed(() => {
  try {
    return componentReadiness(derivedDoc.value);
  } catch {
    return new Map<string, { issues: string[] }>();
  }
});
/** Wiring problems with the selected part: canvas topology + engine readiness (all types) + ERC findings. */
const selectedIssues = computed<string[]>(() => {
  const p = selectedPart.value;
  if (!p) return [];
  const topo = canvas.componentStatus(p.cid).issues;
  const ready = readiness.value.get(p.cid)?.issues ?? [];
  const erc = engineFindings.value
    .filter((f) => f.refs.includes(p.cid))
    .map((f) => ERC_VI[f.rule] ?? f.message);
  // AUD-003: a wire drawn to a pin that has no catalog equivalent is NOT in the running circuit — say so.
  const unmapped = unmappedWires.value
    .filter((u) => u.cid === p.cid)
    .map(
      (u) =>
        `Dây ở chân "${u.pin}" chưa nối vào mạch chạy (chân không có trong catalog) — kiểm tra lại kết nối`,
    );
  return [...new Set([...topo, ...ready, ...erc, ...unmapped])];
});

// On run, push each wired input's resting state: a button reads HIGH (INPUT_PULLUP — the sim does not
// auto-apply pull-ups) and each analog sensor re-asserts its current stimulus so analogRead is correct.
watch(
  () => props.running,
  (run) => {
    if (!run) return;
    void nextTick(() => {
      for (const p of placed.value) {
        const kind = interactionOf(p.type);
        if (kind === 'button') {
          const pin = canvas.controllingDigital(p.cid);
          if (pin !== undefined) emit('button', pin, false);
        } else if (kind === 'analog-sensor') {
          const channel = canvas.controllingAnalog(p.cid);
          if (channel !== undefined) emit('pot', channel, Number(p.props._adc ?? 512));
        }
      }
    });
  },
);

/** Background pointer-down: drop a bend point while wiring, else deselect. */
function onBgDown(e: PointerEvent): void {
  const c = canvas.clientToContent(e);
  canvas.canvasDown(c.x, c.y);
}
/** The fixed content coordinate space the zoom layer scales (board + parts live inside it). */
const BASE_W = 1100;
const BASE_H = 760;
/** Ctrl/⌘ + wheel zooms toward the canvas (plain wheel scrolls the canvas to pan). */
function onWheel(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  canvas.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (pendingPin.value) canvas.cancelPending();
    else {
      selected.value = null;
      canvas.selectWire(null);
    }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !pendingPin.value) {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return; // don't hijack form fields
    if (canvas.selectedWire.value) canvas.removeSelectedWire();
    else if (selected.value) canvas.removePart(selected.value);
  }
}

watch(
  () => placed.value.length,
  () => void nextTick(() => void canvas.refreshAll()),
);
onMounted(() => {
  // Restore the autosaved circuit (placed parts + wires + board pose) so a reload keeps the user's work.
  if (props.initialCanvas) {
    const c = props.initialCanvas;
    placed.value = c.placed as Placed[];
    canvas.wires.value = c.wires as CanvasWire[];
    canvas.boardPos.x = c.boardPos.x;
    canvas.boardPos.y = c.boardPos.y;
    canvas.boardRot.value = c.boardRot;
  }
  void nextTick(() => void canvas.refreshAll());
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

/** AUD-028 — fit-to-container (the ⤢ button): zoom so the whole BASE_W×BASE_H working area fits the visible
 *  canvas viewport. Explicit-only — NOT auto-applied on mount, so the board opens at a usable 100% and the
 *  canvas-scroll keeps it from overflowing the page on small screens. */
const scrollEl = ref<HTMLElement | null>(null);
function fitToView(): void {
  const el = scrollEl.value;
  if (el && el.clientWidth > 0) canvas.fitTo(el.clientWidth, el.clientHeight, BASE_W, BASE_H);
}

// Selection toolbar (Issue 11): it lives OUTSIDE the zoom-layer (fixed chrome), positioned at the
// selected part's SCREEN coordinates and CLAMPED to the visible canvas viewport, so on a narrow phone
// it can never render off-screen with its actions unreachable. Tracked reactively from the scroller.
const toolbarEl = ref<HTMLElement | null>(null);
const scrollX = ref(0);
const scrollY = ref(0);
const viewW = ref(0);
const viewH = ref(0);
const toolbarW = ref(0);
const toolbarH = ref(0);
function syncViewport(): void {
  const el = scrollEl.value;
  if (!el) return;
  scrollX.value = el.scrollLeft;
  scrollY.value = el.scrollTop;
  viewW.value = el.clientWidth;
  viewH.value = el.clientHeight;
}
function measureToolbar(): void {
  toolbarW.value = toolbarEl.value?.offsetWidth ?? 0;
  toolbarH.value = toolbarEl.value?.offsetHeight ?? 0;
}
const toolbarStyle = computed<Record<string, string>>(() => {
  const p = selectedPart.value;
  if (!p) return { left: '0px', top: '0px' }; // unused (toolbar is v-if="selectedPart"), keep the shape stable
  const z = zoom.value;
  // .canvas-scroll is inset:0 of .canvas, so its content origin coincides with .canvas's box. Clamp the
  // toolbar fully inside the viewport using its MEASURED size (the LED toolbar with colour swatches is
  // far wider than a plain one), so it can never overhang off-screen on a phone (Issue 11).
  const w = toolbarW.value || 200;
  const h = toolbarH.value || 36;
  const rawLeft = p.x * z - scrollX.value;
  const rawTop = p.y * z - scrollY.value - h - 6; // sit just above the part
  const maxLeft = Math.max(8, viewW.value - w - 8);
  const maxTop = Math.max(8, viewH.value - h - 8);
  return {
    left: `${Math.max(8, Math.min(rawLeft, maxLeft))}px`,
    top: `${Math.max(8, Math.min(rawTop, maxTop))}px`,
  };
});
function onSelectionChange(): void {
  syncViewport();
  // Clamp with a CONSERVATIVE width on the first frame (the LED toolbar is the widest), so switching
  // from a narrow toolbar to the wide LED one near the right edge can't overhang for a frame (Issue 11).
  toolbarW.value = 320;
  void nextTick(measureToolbar); // then correct to the real measured width
}
watch(selectedPart, onSelectionChange);
// Re-clamp the toolbar on ANY change to the canvas viewport — not just window resize but also a
// WorkspaceShell gutter drag that shrinks/grows the circuit panel (which window 'resize' never fires).
let viewportObserver: ResizeObserver | null = null;
onMounted(() => {
  void nextTick(syncViewport);
  window.addEventListener('resize', syncViewport);
  if (typeof ResizeObserver !== 'undefined' && scrollEl.value) {
    viewportObserver = new ResizeObserver(() => syncViewport());
    viewportObserver.observe(scrollEl.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport);
  viewportObserver?.disconnect();
});
</script>

<template>
  <div class="canvas">
    <div
      ref="scrollEl"
      class="canvas-scroll"
      @pointerdown="onBgDown"
      @pointermove="canvas.onMove"
      @pointerup="canvas.endDrag"
      @pointercancel="canvas.endDrag"
      @wheel="onWheel"
      @scroll="syncViewport"
    >
      <div
        class="zoom-sizer"
        :style="{ width: `${BASE_W * zoom}px`, height: `${BASE_H * zoom}px` }"
      >
        <div
          ref="canvasEl"
          class="zoom-layer"
          :style="{ width: `${BASE_W}px`, height: `${BASE_H}px`, transform: `scale(${zoom})` }"
        >
          <svg class="overlay">
            <!-- committed wires (signal-coloured; click to select → recolour / delete) + endpoint dots -->
            <g v-for="w in wirePaths" :key="w.id">
              <path
                :d="w.d"
                class="wire"
                :class="{ sel: w.selected }"
                :style="{ stroke: w.color }"
                @click.stop="canvas.selectWire(w.id)"
              />
              <circle :cx="w.x1" :cy="w.y1" r="4" class="wdot" :style="{ stroke: w.color }" />
              <circle :cx="w.x2" :cy="w.y2" r="4" class="wdot" :style="{ stroke: w.color }" />
            </g>

            <!-- in-flight rubber-band: solid through bends, dashed to the cursor, white bend dots -->
            <template v-if="pendingPin">
              <path v-if="pendingSolid" :d="pendingSolid" class="pend-solid" />
              <path v-if="rubberPath" :d="rubberPath" class="rubber" />
              <circle
                v-for="(pt, i) in pendingPoints"
                :key="i"
                :cx="pt.x"
                :cy="pt.y"
                r="4.5"
                class="bend"
              />
            </template>

            <!-- board + part pins (top — always clickable, hoverable; breadboard holes are a layer below) -->
            <circle
              v-for="d in partPinDots"
              :key="`${d.cid}:${d.pin}`"
              :cx="d.x"
              :cy="d.y"
              :r="d.active ? 6 : d.connected ? 4.5 : 4"
              class="pin"
              :class="{ active: d.active, connected: d.connected }"
              role="button"
              :aria-label="`Chân ${d.pin}`"
              :data-cid="d.cid"
              :data-pin="d.pin"
              @pointerdown.stop="canvas.clickPin(d.cid, d.pin)"
              @pointerenter="canvas.pinEnter(d.cid, d.pin)"
              @pointerleave="canvas.pinLeave()"
            />
          </svg>

          <!-- breadboard holes — a layer UNDER the parts (z-index 2) so a part plugged into the board covers
               the holes it sits on, yet uncovered holes stay clickable for wiring. -->
          <svg class="bb-holes">
            <!-- conduction strips: the internal copper bus of each in-use column/rail, drawn so the user can
                 see which holes are one node (the path through the board). "live" = reaches a board signal. -->
            <line
              v-for="s in breadboardStrips"
              :key="s.id"
              :x1="s.x1"
              :y1="s.y1"
              :x2="s.x2"
              :y2="s.y2"
              class="bb-strip"
              :class="{ live: s.live }"
            />
            <circle
              v-for="d in breadboardPinDots"
              :key="`${d.cid}:${d.pin}`"
              :cx="d.x"
              :cy="d.y"
              :r="d.active ? 6 : d.connected ? 4.5 : 4"
              class="pin"
              :class="{ active: d.active, connected: d.connected }"
              role="button"
              :aria-label="`Lỗ ${d.pin}`"
              :data-cid="d.cid"
              :data-pin="d.pin"
              @pointerdown.stop="canvas.clickPin(d.cid, d.pin)"
              @pointerenter="canvas.pinEnter(d.cid, d.pin)"
              @pointerleave="canvas.pinLeave()"
            />
          </svg>

          <!-- hover tooltip (pin name) -->
          <div
            v-if="hoverLabel"
            class="pin-tip"
            :style="{ left: `${hoverLabel.x}px`, top: `${hoverLabel.y}px` }"
          >
            {{ hoverLabel.name }}
          </div>

          <!-- selected-wire toolbar: recolour the jumper or delete it -->
          <div
            v-if="selectedWireInfo"
            class="wire-tools"
            :style="{ left: `${selectedWireInfo.mx}px`, top: `${selectedWireInfo.my}px` }"
            @pointerdown.stop
          >
            <button
              v-for="c in WIRE_COLORS"
              :key="c"
              class="wswatch"
              :style="{ background: c }"
              :title="`Đổi màu dây`"
              :aria-label="`Màu ${c}`"
              @click.stop="canvas.setWireColor(selectedWireInfo.id, c)"
            />
            <button
              class="wdel"
              title="Xoá dây"
              aria-label="Xoá dây"
              @click.stop="canvas.removeSelectedWire()"
            >
              ✕
            </button>
          </div>

          <!-- selected-board toolbar: rotate the MCU in 30° steps -->
          <div
            v-if="selected === BOARD_CID"
            class="board-tools"
            :style="{
              left: `${canvas.boardPos.x}px`,
              top: `${Math.max(0, canvas.boardPos.y - 30)}px`,
            }"
            @pointerdown.stop
          >
            <button
              class="btool"
              title="Xoay trái 30°"
              aria-label="Xoay trái"
              @click.stop="canvas.rotateBoard(-1)"
            >
              ⟲
            </button>
            <button
              class="btool"
              title="Xoay phải 30°"
              aria-label="Xoay phải"
              @click.stop="canvas.rotateBoard(1)"
            >
              ⟳
            </button>
          </div>

          <!-- board (draggable from its body; pins live in the SVG overlay above and stop propagation) -->
          <div
            v-if="boardTag"
            class="part board"
            :class="{ sel: selected === BOARD_CID }"
            :style="{ left: `${canvas.boardPos.x}px`, top: `${canvas.boardPos.y}px` }"
            :data-cid="BOARD_CID"
            @pointerdown="onBoardDown"
          >
            <!-- the on-board "L" LED + power LED reflect the firmware (D13 on Uno, GPIO2 on ESP32 DevKit). The
           rotate transform lives on the SAME element `dims`/`pinAbs` measure (the .wokwi-host), so the pin
           dots pivot around the exact centre the art does — putting it on the outer div misaligned them. -->
            <component
              :is="boardTag"
              class="wokwi-host"
              :style="{ transform: boardTransform() }"
              v-bind="boardBindings"
            />
          </div>
          <!-- boards with no wokwi element (ESP32-C3) — drawn from the board catalog so they are wireable -->
          <div
            v-else-if="boardLayout"
            class="part board cboard"
            :class="{ sel: selected === BOARD_CID }"
            :style="{
              left: `${canvas.boardOrigin.value.x}px`,
              top: `${canvas.boardOrigin.value.y}px`,
              width: `${boardLayout.w}px`,
              height: `${boardLayout.h}px`,
              transform: boardTransform(),
            }"
            :data-cid="BOARD_CID"
            @pointerdown="onBoardDown"
          >
            <div class="cb-name">{{ boardLayout.name }}</div>
            <div class="cb-mcu">{{ boardLayout.mcu }}</div>
            <div
              v-for="bp in boardLayout.pins"
              :key="bp.name"
              class="cb-pin"
              :class="{ right: bp.right }"
              :style="{ left: `${bp.px}px`, top: `${bp.py}px` }"
            >
              <span class="cb-label">{{ bp.name }}</span>
            </div>
          </div>
          <div
            v-else
            class="part board fallback"
            :style="{ left: `${canvas.boardPos.x}px`, top: `${canvas.boardPos.y}px` }"
          >
            <div class="fb">{{ boardId }}</div>
            <div class="fbsub">(chưa có hình wokwi — sẽ vẽ riêng)</div>
          </div>

          <!-- placed components (breadboards first → they sit behind the parts plugged into them) -->
          <div
            v-for="p in renderParts"
            :key="p.cid"
            class="part"
            :class="{ selected: p.cid === selected, breadboard: p.type === 'breadboard' }"
            :style="{ left: `${p.x}px`, top: `${p.y}px` }"
            :data-cid="p.cid"
            @pointerdown.stop="onPartDown($event, p)"
          >
            <component
              :is="p.tag"
              class="wokwi-host"
              :style="{ transform: partTransform(p), pointerEvents: hostPointerEvents(p) }"
              v-bind="propsFor(p)"
              @button-press="onButton(p, true)"
              @button-release="onButton(p, false)"
              @input="onPot(p, $event)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- selection toolbar — fixed chrome OUTSIDE the zoom-layer so it never scales or lands off-screen;
         positioned at the part's screen coords, clamped to the viewport (Issue 11). -->
    <div
      v-if="selectedPart"
      ref="toolbarEl"
      class="toolbar"
      :style="toolbarStyle"
      @pointerdown.stop
    >
      <button
        class="tbtn"
        title="Xoay trái 30°"
        data-testid="tool-rotate-ccw"
        @click="canvas.rotatePart(selectedPart.cid, -1)"
      >
        ⟲
      </button>
      <button
        class="tbtn"
        title="Xoay phải 30°"
        data-testid="tool-rotate-cw"
        @click="canvas.rotatePart(selectedPart.cid, 1)"
      >
        ⟳
      </button>
      <button
        class="tbtn"
        title="Lật ngang"
        data-testid="tool-flip"
        @click="canvas.flipPart(selectedPart.cid)"
      >
        ⇆
      </button>
      <span class="rot">{{ selectedPart.rot }}°</span>
      <template v-if="selectedPart.type === 'led'">
        <span class="sep" />
        <button
          v-for="c in LED_COLORS"
          :key="c"
          class="swatch"
          :title="c"
          :style="{ background: c }"
          :class="{ on: (selectedPart.props.color ?? 'red') === c }"
          @click="canvas.setColor(selectedPart.cid, c)"
        />
      </template>
      <span class="sep" />
      <button
        class="tbtn del"
        title="Xoá linh kiện (Delete)"
        data-testid="tool-delete"
        @click="canvas.removePart(selectedPart.cid)"
      >
        🗑
      </button>
    </div>

    <!-- zoom controls (Ctrl/⌘ + wheel also zooms; scroll to pan) -->
    <div class="zoom-ctl">
      <button class="zbtn" title="Thu nhỏ" data-testid="zoom-out" @click="canvas.zoomBy(1 / 1.2)">
        −
      </button>
      <button
        class="zlevel"
        title="Đặt lại 100%"
        data-testid="zoom-reset"
        @click="canvas.resetZoom()"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <button class="zbtn" title="Phóng to" data-testid="zoom-in" @click="canvas.zoomBy(1.2)">
        +
      </button>
      <button class="zbtn fit" title="Vừa khung hình" data-testid="zoom-fit" @click="fitToView()">
        ⤢
      </button>
    </div>

    <!-- wire count + clear (design embedded chip) -->
    <div class="topchip">
      <span class="count">{{ wireCount }} dây nối</span>
      <button
        v-if="wireCount > 0"
        class="clear"
        data-testid="clear-wires"
        @click="canvas.clearWires()"
      >
        Xoá hết dây
      </button>
      <span v-if="pendingPin" class="pending">
        <span class="dot" />Đang vẽ từ {{ pendingName }} — bấm nền bẻ góc, Esc huỷ
        <button class="cancel" data-testid="cancel-wire" @click="canvas.cancelPending()">
          Huỷ
        </button>
      </span>
    </div>

    <!-- add-parts FAB + drawer -->
    <button class="fab" data-testid="canvas-add-part" @click="drawerOpen = !drawerOpen">
      + Linh kiện
    </button>
    <div v-if="drawerOpen" class="drawer">
      <div class="dtitle">Thư viện linh kiện</div>
      <input
        v-model="paletteQuery"
        class="dsearch"
        type="search"
        placeholder="Tìm linh kiện (tên / loại)…"
        data-testid="part-search"
        aria-label="Tìm linh kiện"
      />
      <div class="dgrid">
        <button
          v-for="e in filteredPalette"
          :key="e.type"
          class="ditem"
          :data-testid="`part-${e.type}`"
          @click="addPart(e)"
        >
          {{ e.displayName }}
        </button>
        <div v-if="filteredPalette.length === 0" class="dempty" data-testid="part-empty">
          Không có linh kiện khớp “{{ paletteQuery }}”.
        </div>
      </div>
    </div>

    <!-- property inspector (data-driven from the catalog) for the selected part -->
    <PartInspector
      v-if="selectedPart"
      class="inspector-dock"
      :part="selectedPart"
      :analog-channel="selectedAnalogChannel"
      :issues="selectedIssues"
      @change="onProp"
      @stim="onStim"
    />

    <div class="hint" :class="{ run: running }">
      <template v-if="running">🎉 Linh kiện phản ứng theo firmware đang chạy.</template>
      <template v-else-if="pendingPin"
        >Bấm <b>nền</b> để bẻ góc · bấm <b>chân đích</b> để nối · <b>Esc</b> huỷ.</template
      >
      <template v-else
        >👉 Bấm <b>chân</b> rồi <b>chân đích</b> để nối dây · kéo linh kiện để di chuyển.</template
      >
    </div>
  </div>
</template>

<style scoped>
.canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background-color: #f8f6f1;
  background-image: radial-gradient(#e0d9cc 1.2px, transparent 1.2px);
  background-size: 20px 20px;
  touch-action: none;
}
/* scroll/pan area: holds the zoom layer; the fixed UI (FAB, inspector, zoom controls) are siblings. */
.canvas-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  /* allow native one-finger pan of the background on touch (Issue 15); parts + pins below opt OUT with
     touch-action: none so dragging a part / wiring a pin is never hijacked by the browser's pan. */
  touch-action: pan-x pan-y;
}
.zoom-sizer {
  position: relative;
}
/* the unscaled CONTENT coordinate space (board + parts live here); CSS-scaled to magnify the circuit. */
.zoom-layer {
  position: relative;
  transform-origin: 0 0;
}
/* zoom controls — fixed chrome, not scaled with the circuit. */
.zoom-ctl {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 12px;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 3px;
  box-shadow: var(--shadow-card);
}
.zbtn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--ink-2);
  font-size: 18px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  border-radius: 7px;
}
.zbtn:hover {
  background: var(--accent-bg);
  color: var(--accent-ink);
}
.zlevel {
  min-width: 46px;
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 11.5px;
  font-weight: 800;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.zlevel:hover {
  color: var(--accent-ink);
}
.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
}
/* Breadboard holes: a layer between the board body (1) and the parts (3), so a plugged-in part covers the
   holes it sits on while uncovered holes stay clickable. The svg is click-through; only the dots aren't. */
.bb-holes {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}
/* A breadboard column/rail's internal copper bus — drawn behind the hole dots so the user sees which
   holes are one node. Idle = a soft teal; `live` (the net reaches a board signal pin) glows brighter. */
.bb-strip {
  stroke: #12b886;
  stroke-width: 6.5;
  stroke-linecap: round;
  opacity: 0.34;
  pointer-events: none;
}
.bb-strip.live {
  opacity: 0.64;
}
.wire {
  fill: none;
  stroke: #3b3530;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: auto;
  cursor: pointer;
}
.wire:hover {
  stroke-width: 5;
}
.wdot {
  fill: #fff;
  stroke-width: 2;
}
.pend-solid {
  fill: none;
  stroke: #e8744a;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rubber {
  fill: none;
  stroke: #e8744a;
  stroke-width: 3;
  stroke-dasharray: 6 6;
  stroke-linecap: round;
}
.bend {
  fill: #fff;
  stroke: #e8744a;
  stroke-width: 2.5;
}
.pin {
  fill: #e8744a;
  stroke: #fff;
  stroke-width: 1.5;
  pointer-events: auto;
  cursor: crosshair;
  opacity: 0.55;
  touch-action: none; /* a touch starting on a pin wires it, never pans (Issue 15) */
}
.pin:hover,
.pin.active {
  opacity: 1;
}
/* A wired pin/hole reads teal (vs orange = free) so the user can track connections at a glance. */
.pin.connected {
  fill: #12b886;
  stroke: #fff;
  opacity: 0.92;
}
.pin.connected:hover,
.pin.connected.active {
  opacity: 1;
}
.pin-tip {
  position: absolute;
  z-index: 9;
  transform: translate(-50%, -150%);
  background: #2a2722;
  color: #f4efe6;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 7px;
  pointer-events: none;
  white-space: nowrap;
}
.part {
  position: absolute;
  cursor: grab;
  z-index: 3;
  touch-action: none; /* a touch starting on a part drags it, never pans (Issue 15) */
}
.part.board {
  cursor: grab;
  z-index: 2;
  transform-origin: center center;
}
/* A breadboard is the substrate: it sits at the back so its holes (z 2) and any plugged-in parts (z 3)
   layer on top of it. */
.part.breadboard {
  z-index: 1;
}
.part.selected,
.part.board.sel {
  outline: 2px dashed var(--accent);
  outline-offset: 4px;
  border-radius: 6px;
}
.wire.sel {
  stroke-width: 5.5;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.35));
}
.wire-tools {
  position: absolute;
  z-index: 9;
  transform: translate(-50%, -130%);
  display: flex;
  align-items: center;
  gap: 4px;
  background: #2a2722;
  padding: 5px 7px;
  border-radius: 9px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  pointer-events: auto;
}
.wswatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.55);
  cursor: pointer;
  padding: 0;
}
.wswatch:hover {
  transform: scale(1.18);
}
.wdel {
  width: 18px;
  height: 18px;
  margin-left: 3px;
  border-radius: 6px;
  border: none;
  background: #5a534c;
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}
.board-tools {
  position: absolute;
  z-index: 9;
  display: flex;
  gap: 4px;
  pointer-events: auto;
}
.btool {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}
.btool:hover {
  background: var(--accent-bg);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.wokwi-host {
  /* MUST be a block box: a wokwi web-component defaults to display:inline, whose box collapses to a thin
     baseline strip — so offsetWidth/Height (what dims/pinAbs measure) and `transform-origin: center` both
     came out wrong, and rotating pivoted around the wrong point (pins flew off the art). inline-block makes
     the host wrap the SVG at its intrinsic size so the rotate centre matches the measured centre. */
  display: inline-block;
  transform-origin: center center;
}
.cboard {
  background: linear-gradient(160deg, #2e3138, #23262c);
  border: 1px solid #14161a;
  border-radius: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  color: #cfd3d8;
  cursor: default;
}
.cb-name {
  position: absolute;
  top: 5px;
  left: 0;
  right: 0;
  text-align: center;
  font-weight: 800;
  font-size: 11.5px;
  color: #eef1f5;
}
.cb-mcu {
  position: absolute;
  top: 19px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 8.5px;
  color: #7e8595;
  font-family: var(--font-mono);
}
.cb-pin {
  position: absolute;
}
.cb-pin .cb-label {
  position: absolute;
  top: 0;
  left: 9px;
  transform: translateY(-50%);
  white-space: nowrap;
  font-size: 8.5px;
  font-weight: 700;
  color: #aab0bd;
  font-family: var(--font-mono);
}
.cb-pin.right .cb-label {
  left: auto;
  right: 9px;
}
.fallback .fb {
  background: #23262b;
  color: #cfd3d8;
  font-family: var(--font-mono);
  font-weight: 700;
  padding: 22px 28px;
  border-radius: 10px;
}
.fallback .fbsub {
  font-size: 11px;
  color: var(--ink-faint);
  text-align: center;
  margin-top: 6px;
}
.toolbar {
  position: absolute;
  z-index: 9;
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* wrap (rather than overhang) so it always fits the clamped width (Issue 11) */
  gap: 4px;
  max-width: calc(100vw - 16px); /* hard cap: never wider than the viewport */
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-pop);
  padding: 4px 6px;
}
.tbtn {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--line-2);
  background: var(--panel);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-2);
}
.tbtn:hover {
  border-color: var(--accent);
}
.tbtn.del {
  border-color: #f0cfc6;
  background: #fbeae6;
}
.rot {
  font-size: 11px;
  font-weight: 700;
  color: var(--ink-faint);
  font-family: var(--font-mono);
  min-width: 30px;
  text-align: center;
}
.sep {
  width: 1px;
  height: 18px;
  background: var(--line);
}
.swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px var(--line-2);
  cursor: pointer;
  padding: 0;
}
.swatch.on {
  box-shadow: 0 0 0 2px var(--accent);
}
.topchip {
  position: absolute;
  left: 14px;
  top: 14px;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: calc(100% - 28px);
}
.topchip .count {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-2);
  box-shadow: 0 2px 6px rgba(40, 35, 28, 0.08);
}
.topchip .clear {
  font-family: inherit;
  font-weight: 700;
  font-size: 12px;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid var(--line-2);
  color: var(--ink-2);
  border-radius: 999px;
  padding: 5px 11px;
  box-shadow: 0 2px 6px rgba(40, 35, 28, 0.08);
}
.topchip .pending {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #fbf3ec;
  border: 1px solid #f1d9c9;
  border-radius: 999px;
  padding: 5px 6px 5px 11px;
  font-size: 12px;
  font-weight: 700;
  color: #c25e36;
}
.topchip .pending .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.topchip .cancel {
  font-family: inherit;
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid #f1d9c9;
  color: #c25e36;
  border-radius: 999px;
  padding: 3px 9px;
}
.fab {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 8;
  font-family: inherit;
  font-weight: 800;
  font-size: 13px;
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 11px;
  padding: 9px 15px;
  box-shadow: 0 4px 12px rgba(232, 116, 74, 0.3);
}
.drawer {
  position: absolute;
  left: 14px;
  bottom: 56px;
  z-index: 9;
  width: 244px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-pop);
  padding: 13px;
}
.dtitle {
  font-weight: 800;
  font-size: 13.5px;
  margin-bottom: 9px;
}
.dsearch {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 9px;
  padding: 7px 10px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  font-size: 13px;
  background: var(--panel, #fff);
  color: var(--ink, inherit);
}
.dsearch:focus {
  outline: none;
  border-color: var(--accent, #1c7ed6);
}
.dgrid {
  display: grid;
  /* minmax(0,1fr) lets columns shrink below a long part name (the grid-blowout fix); only scroll
     vertically so the library never scrolls sideways (responsive in the fixed-width drawer). */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  overflow-x: hidden;
}
.dempty {
  grid-column: 1 / -1;
  padding: 14px 4px;
  font-size: 12.5px;
  color: var(--ink-faint, #888);
  text-align: center;
}
.ditem {
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 9px 8px;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-2);
  background: var(--panel);
  cursor: grab;
  text-align: center;
  min-width: 0; /* allow the button to shrink inside its grid cell */
  overflow-wrap: anywhere; /* wrap long part names instead of forcing a horizontal scroll */
}
.ditem:hover {
  border-color: var(--accent);
  color: var(--accent-ink);
  background: var(--accent-bg);
}
.inspector-dock {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 9;
  max-height: calc(100% - 28px);
  overflow: auto;
}
.hint {
  position: absolute;
  right: 14px;
  top: 14px;
  max-width: 230px;
  background: var(--dark);
  color: #f4efe6;
  border-radius: 13px;
  padding: 10px 13px;
  font-size: 12px;
  line-height: 1.5;
  font-weight: 600;
  z-index: 8;
}
.hint b {
  color: #7fd3a3;
}
@media (max-width: 560px) {
  /* on very small phones the top-right hint overlaps the top-left wire-count chip — drop the hint
     (least-essential chrome) and keep the chip inside the viewport (Issue 12). */
  .hint {
    display: none;
  }
  .topchip {
    max-width: calc(100vw - 24px);
  }
  /* lift the inspector ABOVE the bottom-centred zoom controls so they never overlap on a phone (PR-04). */
  .inspector-dock {
    bottom: 56px;
    max-height: calc(100% - 70px);
  }
}
</style>
