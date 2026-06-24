<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
  defineAsyncComponent,
  h,
} from 'vue';
import { boardInfo, boardHasWifi } from '../lib/boards';
import { saveProject, type SavedCanvas } from '../lib/persist';
import { useSimRunner } from '../composables/useSimRunner';
import { useResizableLayout } from '../composables/useResizableLayout';
import { useUserLibraries } from '../composables/useUserLibraries';
import type { RegistryLib } from '../lib/library-registry';
import { formatArduino } from '../lib/format-code';
import { documentToNetlist, type CircuitDocument } from '@sparklab/schematic';
import type { UnmappedEndpoint } from '../lib/canvas-to-document';
import { VIRTUAL_WIFI } from '@sparklab/network-shim';
import primeraMark from '../assets/brand/primera-mark.png';

import PrimeraLoader from './PrimeraLoader.vue';

// A stale/aborted chunk fetch (e.g. an asset 404 after a redeploy) must not pin the canvas pane on the
// loader forever — show an actionable error instead.
const CanvasLoadError = {
  name: 'CanvasLoadError',
  setup() {
    const reload = (): void => {
      if (typeof location !== 'undefined') location.reload();
    };
    return () =>
      h('div', { style: 'padding:28px;text-align:center;color:#6b6256;font-size:14px' }, [
        h(
          'p',
          { style: 'margin:0 0 10px' },
          'Không tải được khung mạch — có thể do mất mạng hoặc bản build đã đổi.',
        ),
        h(
          'button',
          {
            onClick: reload,
            style:
              'padding:8px 18px;border:0;border-radius:8px;background:#1a1a1a;color:#fff;font-weight:600;cursor:pointer',
          },
          'Tải lại trang',
        ),
      ]);
  },
};

// wokwi-elements (+ lit) are heavy; load the canvas only when a workspace actually mounts so the
// start screen stays lean. While that chunk loads, show the Primera loading animation.
const WokwiCanvas = defineAsyncComponent({
  loader: () => import('./WokwiCanvas.vue'),
  loadingComponent: PrimeraLoader,
  errorComponent: CanvasLoadError,
  delay: 120,
  timeout: 30000,
});

const props = defineProps<{
  boardId: string;
  name: string;
  initialSketch: string;
  initialCanvas?: SavedCanvas | null;
}>();
defineEmits<{ back: []; 'open-labs': [] }>();

const board = computed(() => boardInfo(props.boardId));
// The WiFi entry is board-aware: `WiFi.h` ships in the ESP32 SDK packs only, so on the AVR Uno the panel
// must say it needs an ESP32 board rather than falsely claiming "built in" (the misleading-label fix).
const libs = computed(() => {
  const hasWifi = boardHasWifi(props.boardId);
  return [
    { name: 'Adafruit NeoPixel', ver: 'v1.12.0 · từ kho thư viện', bg: '#E6F0E9' },
    { name: 'DHT sensor library', ver: 'v1.4.6 · từ kho thư viện', bg: '#E4ECF7' },
    { name: 'LiquidCrystal I2C', ver: 'v1.1.2 · do bạn tải lên', bg: '#FBE9DF', zip: true },
    hasWifi
      ? { name: 'WiFi', ver: 'Tích hợp sẵn trong bo mạch', bg: '#EFEBE2', builtin: true }
      : {
          name: 'WiFi',
          ver: 'Cần bo ESP32 — Arduino Uno không có WiFi',
          bg: '#EFEBE2',
          builtin: false,
        },
  ];
});
const sketch = ref(props.initialSketch);
// Flexible panel sizing: editor column ~1/3 by default, draggable gutters resize the editor↔circuit
// split and the circuit↔serial split (persisted; double-click a gutter to reset).
const layoutEl = ref<HTMLElement | null>(null);
const {
  editorFrac,
  serialPx,
  startCol,
  startRow,
  reset: resetLayout,
} = useResizableLayout(layoutEl);

const tab = ref<'code' | 'libs'>('code');

// ── user-uploaded libraries (.zip) ────────────────────────────────────────────────────────────────
const {
  libraries: userLibraries,
  busy: userLibBusy,
  addZip,
  remove: removeLib,
  results: libResults,
  searching: libSearching,
  registryError: libRegError,
  search: searchRegistry,
  install: installRegistry,
} = useUserLibraries();
const libQuery = ref('');
let libSearchTimer: number | undefined;
function onLibSearchInput(): void {
  window.clearTimeout(libSearchTimer);
  libSearchTimer = window.setTimeout(() => void searchRegistry(libQuery.value), 350); // debounce
}
async function onLibInstall(lib: RegistryLib): Promise<void> {
  libMsg.value = { ok: true, text: `Đang cài "${lib.name}"…` };
  const r = await installRegistry(lib);
  libMsg.value = r.ok
    ? { ok: true, text: `Đã cài "${r.name}". Dùng #include trong code.` }
    : { ok: false, text: r.error ?? 'Lỗi.' };
}
const libFileInput = ref<HTMLInputElement | null>(null);
const libDragOver = ref(false);
const libMsg = ref<{ ok: boolean; text: string } | null>(null);
async function addLibFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    libMsg.value = { ok: false, text: 'Chỉ nhận file .zip.' };
    return;
  }
  const r = await addZip(file);
  libMsg.value = r.ok
    ? { ok: true, text: `Đã thêm thư viện "${r.name}". Dùng #include trong code.` }
    : { ok: false, text: r.error ?? 'Lỗi.' };
}
function onLibPick(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void addLibFile(file);
  (e.target as HTMLInputElement).value = ''; // allow re-picking the same file
}
function onLibDrop(e: DragEvent): void {
  libDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) void addLibFile(file);
}
function onLibRemove(name: string): void {
  void removeLib(name);
  libMsg.value = { ok: true, text: `Đã gỡ "${name}".` };
}

// autosave: persist the sketch AND the drawn circuit (board/name too) on every edit, so a reload restores
// the user's work (AUD-001). The status is HONEST: 'saved' only after a successful write; 'error' if
// storage rejected it (quota/private mode), never a silent lie.
const canvasState = ref<SavedCanvas | null>(props.initialCanvas ?? null);
const saveStatus = ref<'idle' | 'saved' | 'error'>(
  props.initialCanvas !== undefined ? 'saved' : 'idle',
);
function persistNow(): void {
  const ok = saveProject({
    boardId: props.boardId,
    name: props.name,
    sketch: sketch.value,
    canvas: canvasState.value,
  });
  saveStatus.value = ok ? 'saved' : 'error';
}
watch([sketch, canvasState], persistNow, { deep: true });

// All compile/run/poll/stop lifecycle (incl. stop-on-unmount + re-entrancy + error handling) lives
// in the runner composable so this component stays presentational.
const {
  status,
  running,
  message,
  buildNotes,
  serial,
  ledOn,
  pins,
  ledToggles,
  vtimeMs,
  devices,
  pwmDuty,
  networkTier,
  network,
  run,
  stop,
  setButton,
  setPot,
  setDeviceProp,
} = useSimRunner();
// WiFi tier control is shown only for boards that have WiFi (ESP32). 'real' = real Internet (the DEFAULT
// when online); 'fake' = offline Tier 1 (deterministic virtual broker, no egress — the fallback when the
// browser is offline). The badge mirrors WiFi.status() while running.
const showNetwork = computed(() => boardHasWifi(props.boardId));

// Serial monitor: follow the tail by default so the newest output stays visible — no more scrolling down
// by hand. "Tự cuộn" lets the user turn it off to read back; scrolling up pauses the follow, returning to
// the bottom resumes it.
const serialLog = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
function scrollSerialToTail(): void {
  const el = serialLog.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onSerialScroll(): void {
  const el = serialLog.value;
  if (el) autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
watch(serial, () => {
  if (autoScroll.value) void nextTick(scrollSerialToTail);
});
watch(autoScroll, (on) => {
  if (on) void nextTick(scrollSerialToTail);
});
const wifiLabel = computed(() => {
  const w = network.value?.wifi;
  return w === 'connected'
    ? 'WiFi: đã kết nối'
    : w === 'connecting'
      ? 'WiFi: đang kết nối…'
      : 'WiFi: chưa kết nối';
});

// The drawn circuit, mirrored up from the canvas, so a Run binds its devices to the firmware
// (the root-cause fix: DHT/LCD/servo/HC-SR04 the user drew reach the emulator + reflect back).
const circuitDoc = ref<CircuitDocument | null>(null);
// AUD-003: wires the canvas drew but couldn't reconcile to a catalog pin — NOT in the running netlist.
const unmappedWires = ref<UnmappedEndpoint[]>([]);
function toggleRun(): void {
  void (running.value ? stop() : run(sketch.value, props.boardId, circuitDoc.value));
}

// Global circuit verdict (ERC summary + unmapped wires) for the panel header — surfaced so a drawn-but-
// unconnected wire can't fail silently (the user sees the count before/while running).
const circuitVerdict = computed(() => {
  const unmapped = unmappedWires.value.length;
  if (!circuitDoc.value) return unmapped ? { errors: 0, warns: 0, unmapped } : null;
  try {
    const erc = documentToNetlist(circuitDoc.value).erc;
    const errors = erc.filter((f) => f.severity === 'error').length;
    const warns = erc.filter((f) => f.severity === 'warning').length;
    return errors || warns || unmapped ? { errors, warns, unmapped } : null;
  } catch {
    return unmapped ? { errors: 0, warns: 0, unmapped } : null;
  }
});

// ── basic code-editor ergonomics: Format button (Shift+Alt+F) + Tab-inserts-spaces + auto-indent ──
function formatCode(): void {
  sketch.value = formatArduino(sketch.value);
}
// Accessibility (AUD-029): Tab normally inserts indentation, which traps keyboard users in the editor.
// Pressing Escape first lets the NEXT Tab move focus out normally (a published, standard escape pattern).
let editorTabEscape = false;
function onEditorKeydown(e: KeyboardEvent): void {
  const el = e.target as HTMLTextAreaElement;
  if (
    (e.shiftKey && e.altKey && (e.key === 'F' || e.key === 'f')) ||
    (e.key === 'i' && (e.metaKey || e.ctrlKey) && e.shiftKey)
  ) {
    e.preventDefault();
    formatCode();
    return;
  }
  if (e.key === 'Escape') {
    editorTabEscape = true; // arm: the next Tab tabs OUT of the editor instead of indenting
    return;
  }
  if (e.key === 'Tab') {
    if (editorTabEscape) {
      editorTabEscape = false;
      return; // allow the default → focus leaves the editor (keyboard-accessible)
    }
    e.preventDefault();
    insertAtCursor(el, '  '); // 2 spaces, indentation within the editor
    return;
  }
  editorTabEscape = false; // any other key disarms the escape
  if (e.key === 'Enter') {
    // auto-indent: carry the current line's leading whitespace, +2 if it ends with an opening brace.
    const start = el.selectionStart;
    const lineStart = el.value.lastIndexOf('\n', start - 1) + 1;
    const line = el.value.slice(lineStart, start);
    const indent = (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '  ');
    const extra = /[{([]\s*$/.test(line) ? '  ' : '';
    e.preventDefault();
    insertAtCursor(el, '\n' + indent + extra);
  }
}
function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  const s = el.selectionStart;
  const eEnd = el.selectionEnd;
  const next = el.value.slice(0, s) + text + el.value.slice(eEnd);
  sketch.value = next;
  void nextTick(() => {
    el.selectionStart = el.selectionEnd = s + text.length;
  });
}

// Narrow-viewport flag drives a SINGLE running-status text node (no duplicated full+compact strings in
// the DOM, which would be noisy for assistive tech / text assertions — PR-05). Matches the ≤900px layout.
const narrow = ref(false);
let statusMql: MediaQueryList | null = null;
const onNarrowChange = (e: MediaQueryListEvent): void => {
  narrow.value = e.matches;
};
onMounted(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  statusMql = window.matchMedia('(max-width: 900px)');
  narrow.value = statusMql.matches;
  statusMql.addEventListener('change', onNarrowChange);
});
onBeforeUnmount(() => statusMql?.removeEventListener('change', onNarrowChange));
const runningStatusText = computed(() =>
  narrow.value
    ? 'Đang chạy · thời gian ảo'
    : 'Đang chạy · firmware thật, thời gian ảo (không đồng bộ wall-clock)',
);
</script>

<template>
  <div class="ws">
    <!-- app bar -->
    <div class="appbar">
      <button
        class="icon"
        data-testid="ws-back"
        title="Về trang chủ"
        aria-label="Về trang chủ"
        @click="$emit('back')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 5 8 12l7 7"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <!-- brand mark: SparkLab is a product of Primera Tech Labs (light chip so it reads on the dark appbar) -->
      <span
        class="brandchip"
        data-testid="brand-chip"
        title="SparkLab — sản phẩm của Công ty TNHH Primera Tech Labs"
        aria-label="Primera Tech Labs"
      >
        <img :src="primeraMark" alt="Primera Tech Labs" />
      </span>
      <div class="file">
        <div class="fname">{{ name }}<span class="ext">.ino</span></div>
        <div class="saved" :class="{ unsaved: saveStatus === 'error' }">
          {{
            saveStatus === 'error'
              ? '⚠ Chưa lưu được (bộ nhớ đầy?)'
              : saveStatus === 'saved'
                ? 'Đã lưu tự động'
                : 'Tự động lưu'
          }}
        </div>
      </div>
      <div class="boardchip"><span class="bdot"></span>{{ board?.name ?? boardId }}</div>
      <span style="flex: 1"></span>

      <!-- Network tier (ESP32 only): real Internet by default when online, virtual/offline as fallback. WiFi badge while running. -->
      <div v-if="showNetwork" class="netctl" data-testid="ws-network">
        <span
          class="wifi-chip"
          data-testid="ws-wifi-ssid"
          :title="`WiFi ảo của trình mô phỏng. Trong code: WiFi.begin(&quot;${VIRTUAL_WIFI.ssid}&quot;, &quot;&quot;); — chấp nhận mọi SSID/mật khẩu.`"
        >
          📡 WiFi ảo: <b>{{ VIRTUAL_WIFI.ssid }}</b
          ><span class="wifi-open">· mở</span>
        </span>
        <select
          v-model="networkTier"
          class="nettier"
          :disabled="running"
          data-testid="ws-net-tier"
          title="Chọn lớp mạng cho ESP32"
        >
          <option value="real">🌐 Internet thật</option>
          <option value="fake">📶 Mạng ảo (offline)</option>
          <option value="off">⊘ Tắt mạng</option>
        </select>
        <span
          v-if="running && networkTier !== 'off'"
          class="netbadge"
          :class="network?.wifi ?? 'off'"
          data-testid="ws-wifi"
          >{{ wifiLabel }}</span
        >
        <span
          v-if="running && network?.blynkOnline"
          class="netbadge connected"
          data-testid="ws-blynk"
          title="Thiết bị đang giữ phiên Blynk (MQTT-over-WebSocket) — hiển thị 'online' trên dashboard Blynk."
          >🟢 Blynk: online</span
        >
        <span
          v-if="running && network?.error"
          class="netbadge neterr"
          data-testid="ws-net-error"
          :title="network.error"
          >⚠ {{ network.error }}</span
        >
      </div>

      <div
        class="status"
        :class="status"
        :data-status="status"
        :title="
          status === 'running'
            ? 'Đang chạy · firmware thật, thời gian ảo (không đồng bộ wall-clock)'
            : undefined
        "
        data-testid="ws-status"
      >
        <span class="sdot"></span>
        <!-- a SINGLE node — compact on narrow viewports so the appbar stays short, full on desktop (Issue 13/PR-05) -->
        <template v-if="status === 'running'">{{ runningStatusText }}</template>
        <template v-else-if="status === 'compiling'">Đang biên dịch…</template>
        <template v-else-if="status === 'error'">Biên dịch thất bại</template>
        <template v-else>Sẵn sàng</template>
      </div>

      <button v-if="running" class="run stopbtn" data-testid="ws-stop" @click="toggleRun">
        <span class="sq"></span>Dừng
      </button>
      <button v-else class="run" data-testid="ws-run" @click="toggleRun">
        <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="#fff" /></svg>Chạy
      </button>
    </div>

    <!-- Layout A — resizable: editor | (circuit / serial). Drag the gutters; double-click to reset. -->
    <div
      ref="layoutEl"
      class="layout"
      :style="{ '--col-editor': editorFrac, '--row-serial': serialPx + 'px' }"
    >
      <!-- editor -->
      <section class="panel editor">
        <div class="phead">
          <button
            class="ptab"
            :class="{ on: tab === 'code' }"
            data-testid="tab-code"
            @click="tab = 'code'"
          >
            <span class="pdot" />sketch.ino
          </button>
          <button
            class="ptab"
            :class="{ on: tab === 'libs' }"
            data-testid="tab-libs"
            @click="tab = 'libs'"
          >
            <svg viewBox="0 0 24 24" class="i">
              <path
                d="M5 5h6v14H5z M13 5h6v14h-6z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linejoin="round"
              /></svg
            >Thư viện
          </button>
          <span style="flex: 1"></span>
          <button
            v-if="tab === 'code'"
            class="fmtbtn"
            data-testid="editor-format"
            title="Định dạng mã (Shift+Alt+F)"
            @click="formatCode"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 6h16M4 10h10M4 14h16M4 18h8"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            Định dạng
          </button>
          <span class="phint">C++ · Arduino</span>
        </div>
        <textarea
          v-if="tab === 'code'"
          v-model="sketch"
          class="code"
          spellcheck="false"
          aria-label="Mã nguồn Arduino"
          data-testid="editor-code"
          @keydown="onEditorKeydown"
        ></textarea>
        <div v-else class="libs">
          <div class="libs-title">Thư viện lập trình</div>
          <p>
            Thêm thư viện Arduino cho cảm biến, màn hình… Tải lên file <b>.zip</b> rồi
            <code>#include</code> trong code.
          </p>
          <div
            class="dropzone"
            :class="{ over: libDragOver }"
            data-testid="lib-dropzone"
            @dragover.prevent="libDragOver = true"
            @dragleave.prevent="libDragOver = false"
            @drop.prevent="onLibDrop"
          >
            <!-- reading/extracting an uploaded .zip is async — show the brand loader -->
            <PrimeraLoader v-if="userLibBusy" :width="150" label="Đang xử lý thư viện…" />
            <template v-else>
              <div class="dz-ic">↑</div>
              <div class="dz-main">Kéo thả file thư viện .zip vào đây</div>
              <div class="dz-or">hoặc</div>
              <button class="dz-btn" data-testid="lib-upload" @click="libFileInput?.click()">
                Chọn file .zip để tải lên
              </button>
            </template>
            <input
              ref="libFileInput"
              type="file"
              accept=".zip"
              hidden
              data-testid="lib-file"
              @change="onLibPick"
            />
          </div>
          <p v-if="libMsg" class="lib-msg" :class="libMsg.ok ? 'ok' : 'err'" data-testid="lib-msg">
            {{ libMsg.text }}
          </p>

          <div class="lib-sec">Tìm trong kho thư viện (Arduino Library Manager)</div>
          <input
            v-model="libQuery"
            class="lib-searchbox"
            type="text"
            placeholder="🔎 Gõ tên thư viện, ví dụ: DHT, OneWire, Adafruit…"
            data-testid="lib-search"
            @input="onLibSearchInput"
          />
          <div v-if="libSearching" class="lib-loading">
            <PrimeraLoader :width="120" label="Đang tìm trong kho thư viện…" />
          </div>
          <p v-else-if="libRegError" class="lib-msg err">{{ libRegError }}</p>
          <div v-for="lib in libResults" :key="lib.name" class="lib-row" data-testid="lib-result">
            <span class="lib-ic" style="background: #eef2e8"></span>
            <div class="lib-meta">
              <div class="lib-name">
                {{ lib.name }}
                <span class="lib-ver" style="display: inline">v{{ lib.version }}</span>
              </div>
              <div class="lib-ver">{{ lib.sentence }}</div>
            </div>
            <button
              class="lib-add"
              :disabled="userLibBusy"
              :title="`Cài ${lib.name}`"
              data-testid="lib-install"
              @click="onLibInstall(lib)"
            >
              Cài
            </button>
          </div>

          <div class="lib-sec">Thư viện bạn đã tải lên</div>
          <p v-if="!userLibraries.length" class="lib-empty">
            Chưa có. Tải một file .zip ở trên — lưu ý trình mô phỏng dùng HAL tối giản nên thư viện
            gọi API chưa hỗ trợ có thể không biên dịch được.
          </p>
          <div v-for="l in userLibraries" :key="l.name" class="lib-row" data-testid="user-lib">
            <span class="lib-ic" style="background: #e2ecf7"></span>
            <div class="lib-meta">
              <div class="lib-name">
                {{ l.name
                }}<span class="lib-tag">#include &lt;{{ l.provides[0] ?? l.name + '.h' }}&gt;</span>
              </div>
              <div class="lib-ver">
                v{{ l.version }} · {{ l.sources.length }} file nguồn · {{ l.headers.length }} header
              </div>
            </div>
            <button
              class="lib-rm"
              :title="`Gỡ ${l.name}`"
              data-testid="lib-remove"
              @click="onLibRemove(l.name)"
            >
              Gỡ
            </button>
          </div>

          <div class="lib-sec">Thư viện tích hợp sẵn</div>
          <div v-for="l in libs" :key="l.name" class="lib-row">
            <span class="lib-ic" :style="{ background: l.bg }"></span>
            <div class="lib-meta">
              <div class="lib-name">{{ l.name }}</div>
              <div class="lib-ver">{{ l.ver }}</div>
            </div>
            <span v-if="l.builtin" class="ok">Sẵn có</span>
          </div>
        </div>
      </section>

      <!-- vertical gutter: drag to resize editor↔circuit width; double-click resets -->
      <div
        class="gutter gutter-col"
        data-testid="gutter-col"
        title="Kéo để chỉnh độ rộng · nhấp đúp để đặt lại"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startCol"
        @dblclick="resetLayout"
      >
        <span class="grip" />
      </div>

      <!-- circuit -->
      <section class="panel circuit">
        <div class="phead">
          <span class="ptitle">Mạch mô phỏng</span>
          <span
            v-if="circuitVerdict"
            class="verdict"
            :class="{ err: circuitVerdict.errors > 0 || circuitVerdict.unmapped > 0 }"
            data-testid="circuit-verdict"
            :title="
              circuitVerdict.unmapped
                ? `${circuitVerdict.unmapped} dây chưa nối được vào mạch chạy — kiểm tra lại kết nối các chân`
                : circuitVerdict.errors
                  ? 'Có lỗi mạch — sửa trước khi chạy'
                  : 'Có cảnh báo mạch'
            "
          >
            <span v-if="circuitVerdict.errors || circuitVerdict.unmapped" class="vdot err"></span
            ><span v-else class="vdot warn"></span>
            {{ circuitVerdict.errors ? `${circuitVerdict.errors} lỗi` : ''
            }}{{ circuitVerdict.errors && circuitVerdict.warns ? ' · ' : ''
            }}{{ circuitVerdict.warns ? `${circuitVerdict.warns} cảnh báo` : ''
            }}{{
              (circuitVerdict.errors || circuitVerdict.warns) && circuitVerdict.unmapped
                ? ' · '
                : ''
            }}{{ circuitVerdict.unmapped ? `${circuitVerdict.unmapped} dây chưa nối` : '' }}
          </span>
          <span style="flex: 1"></span>
          <span class="phint">— kéo linh kiện từ khay, bấm chân để nối dây</span>
        </div>
        <div class="canvas-host">
          <WokwiCanvas
            :board-id="boardId"
            :led-on="ledOn"
            :pins="pins"
            :running="running"
            :devices="devices"
            :pwm-duty="pwmDuty"
            @button="setButton"
            @pot="setPot"
            :initial-canvas="initialCanvas"
            @circuit="circuitDoc = $event"
            @unmapped="unmappedWires = $event"
            @state="canvasState = $event"
            @device-prop="setDeviceProp"
          />
          <!-- compile/build is the long wait (cold toolchain download + compile) — show the brand loader -->
          <PrimeraLoader
            v-if="status === 'compiling'"
            overlay
            :width="240"
            :label="message || 'Đang biên dịch…'"
            sub="Lần đầu có thể mất một lúc để tải bộ công cụ — vui lòng đợi."
          />
        </div>
      </section>

      <!-- horizontal gutter: drag to resize circuit↔serial height; double-click resets -->
      <div
        class="gutter gutter-row"
        data-testid="gutter-row"
        title="Kéo để chỉnh chiều cao · nhấp đúp để đặt lại"
        role="separator"
        aria-orientation="horizontal"
        @pointerdown="startRow"
        @dblclick="resetLayout"
      >
        <span class="grip" />
      </div>

      <!-- serial -->
      <section class="panel serial">
        <div class="phead">
          <span class="ptitle">Cổng Serial</span>
          <span class="phint mono"
            >{{ (vtimeMs / 1000).toFixed(1) }}s ảo · {{ ledToggles }} lần đổi</span
          >
          <span style="flex: 1"></span>
          <label class="autoscroll" title="Tự động cuộn xuống dòng mới nhất">
            <input v-model="autoScroll" type="checkbox" data-testid="ws-serial-autoscroll" />
            ↓ Tự cuộn
          </label>
          <span v-if="message" class="errmsg" data-testid="ws-message">{{ message }}</span>
        </div>
        <div v-if="buildNotes.length" class="buildnotes" data-testid="ws-build-notes">
          <p v-for="(note, i) in buildNotes" :key="i">ⓘ {{ note }}</p>
        </div>
        <pre ref="serialLog" class="log" data-testid="serial-log" @scroll="onSerialScroll">{{
          serial || (status === 'idle' ? '— Bấm Chạy để biên dịch và xem kết quả —' : '')
        }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ws {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--bg);
}
.appbar {
  height: 58px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
.icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b6459;
}
.icon svg {
  width: 18px;
  height: 18px;
}
.file .fname {
  font-size: 14.5px;
  font-weight: 800;
}
.file .ext {
  font-weight: 600;
  color: var(--ink-faint);
}
.file .saved {
  font-size: 11.5px;
  color: #a39a8b;
  font-weight: 600;
}
.file .saved.unsaved {
  color: var(--red-ink);
}
.brandchip {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: #fff;
  padding: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.brandchip img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.boardchip {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #f4f1ea;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  padding: 5px 12px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink-2);
}
.bdot {
  width: 22px;
  height: 15px;
  border-radius: 3px;
  background: #0e8c9b;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 700;
  border-radius: var(--r-pill);
  padding: 6px 13px;
  border: 1px solid var(--line);
  background: #f4f1ea;
  color: var(--ink-soft);
}
.status .sdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #bbb1a1;
}
.status.running {
  color: var(--green-ink);
  background: var(--green-bg);
  border-color: var(--green-line);
}
.status.running .sdot {
  background: var(--green);
  animation: pulsedot 1.4s ease-in-out infinite;
}
.status.error {
  color: var(--red-ink);
  background: var(--red-bg);
  border-color: var(--red-line);
}
.status.error .sdot {
  background: var(--red);
}
.netctl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: 4px;
}
.wifi-chip {
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px dashed var(--line);
  background: #f4f1ea;
  color: var(--ink-soft);
  white-space: nowrap;
  cursor: help;
}
.wifi-chip b {
  color: var(--ink);
}
.wifi-open {
  margin-left: 4px;
  opacity: 0.7;
}
.nettier {
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #f4f1ea;
  color: var(--ink-soft);
  cursor: pointer;
}
.nettier:disabled {
  opacity: 0.6;
  cursor: default;
}
.netbadge {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #f4f1ea;
  color: var(--ink-soft);
  white-space: nowrap;
}
.netbadge.connected {
  color: var(--green-ink);
  background: var(--green-bg);
  border-color: var(--green-line);
}
.netbadge.connecting {
  color: #946200;
  background: #fbf3e0;
  border-color: #ecd9a8;
}
.netbadge.neterr {
  color: var(--red-ink);
  background: #fdecec;
  border-color: #f0b8b8;
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.run {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: inherit;
  font-weight: 800;
  font-size: 14px;
  cursor: pointer;
  background: var(--green);
  color: #fff;
  border: none;
  border-radius: 11px;
  padding: 10px 19px;
  box-shadow: 0 2px 8px rgba(63, 163, 107, 0.3);
}
.run svg {
  width: 15px;
  height: 15px;
}
.run.stopbtn {
  background: var(--panel);
  color: var(--red-ink);
  border: 1.5px solid #eac6bd;
  box-shadow: none;
}
.run .sq {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: var(--red-ink);
}
.ghost {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--ink-soft);
  font-family: inherit;
  font-weight: 700;
  font-size: 12px;
  padding: 7px 11px;
  border-radius: 9px;
  cursor: pointer;
}
.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  /* editor column = --col-editor (fraction of width, default 1/3) | gutter | circuit/serial fill the rest.
     Rows: circuit fills | gutter | serial = --row-serial. Both gutters are draggable (useResizableLayout). */
  --col-editor: 0.3333;
  --row-serial: 232px;
  grid-template-columns: minmax(0, calc(var(--col-editor) * 100%)) 10px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) 10px var(--row-serial);
  gap: 0 0;
  padding: 14px;
}
.gutter {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  touch-action: none; /* pointer drag owns the gesture */
  z-index: 6;
}
.gutter-col {
  grid-column: 2;
  grid-row: 1 / 4;
  cursor: col-resize;
}
.gutter-row {
  grid-column: 3;
  grid-row: 2;
  cursor: row-resize;
}
.gutter .grip {
  background: var(--line);
  border-radius: 999px;
  transition: background 0.15s;
}
.gutter-col .grip {
  width: 4px;
  height: 42px;
}
.gutter-row .grip {
  width: 42px;
  height: 4px;
}
.gutter:hover .grip,
.gutter:active .grip {
  background: var(--accent, #2f6f4f);
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-card);
}
.editor {
  grid-column: 1;
  grid-row: 1 / 4; /* full height, left of the vertical gutter */
}
.circuit {
  grid-column: 3;
  grid-row: 1;
}
.serial {
  grid-column: 3;
  grid-row: 3;
}
.phead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  height: 44px;
  border-bottom: 1px solid var(--line-3);
}
.ptitle {
  font-weight: 800;
  font-size: 13.5px;
}
.phint {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-faint);
}
.phint.mono {
  font-family: var(--font-mono);
}
.verdict {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 800;
  color: var(--amber-ink, #9a6a00);
  background: var(--amber-bg, #fff4e0);
  border: 1px solid var(--amber-line, #f0d49a);
  border-radius: var(--r-pill);
  padding: 3px 9px;
}
.verdict.err {
  color: var(--red-ink);
  background: var(--red-bg);
  border-color: var(--red-line);
}
.vdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.vdot.err {
  background: var(--red);
}
.vdot.warn {
  background: #e8a33d;
}
.fmtbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: inherit;
  font-weight: 700;
  font-size: 11.5px;
  color: var(--ink-soft);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 9px;
  cursor: pointer;
}
.fmtbtn:hover {
  background: var(--accent-bg);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.fmtbtn svg {
  width: 13px;
  height: 13px;
}
.ptab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: transparent;
  border: 1px solid transparent;
  color: #9a9183;
  font-family: inherit;
  font-weight: 700;
  font-size: 12.5px;
  padding: 5px 11px;
  border-radius: 9px;
  cursor: pointer;
}
.ptab.on {
  background: var(--accent-bg);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.ptab .pdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d8cdbb;
}
.ptab.on .pdot {
  background: var(--accent);
}
.ptab .i {
  width: 13px;
  height: 13px;
}
.code {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.78;
  background: var(--panel-3);
  color: var(--ink-2);
}
.libs {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.libs-title {
  font-size: 15.5px;
  font-weight: 800;
}
.libs p {
  font-size: 12.5px;
  color: #857c70;
  line-height: 1.55;
}
.dropzone {
  border: 2px dashed var(--accent-line);
  background: var(--accent-bg);
  border-radius: 14px;
  padding: 20px;
  text-align: center;
  font-weight: 800;
  color: var(--accent-ink);
  font-size: 13.5px;
}
.dropzone.over {
  border-color: var(--accent, #2f6f4f);
  background: #eaf3ee;
}
.dz-btn {
  margin-top: 8px;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 8px;
  padding: 7px 14px;
}
.dz-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.lib-msg {
  font-size: 12.5px;
  margin: 8px 2px 0;
}
.lib-msg.ok {
  color: var(--green-ink);
}
.lib-msg.err {
  color: var(--red-ink);
}
.lib-empty {
  font-size: 12.5px;
  color: var(--ink-soft);
}
.lib-loading {
  display: flex;
  justify-content: center;
  padding: 14px 0;
}
.lib-searchbox {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 13px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #fff;
  margin-bottom: 4px;
}
.lib-add {
  margin-left: auto;
  font: inherit;
  font-weight: 700;
  font-size: 11.5px;
  cursor: pointer;
  color: #fff;
  background: var(--accent, #2f6f4f);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
}
.lib-add:disabled {
  opacity: 0.55;
  cursor: default;
}
.lib-tag {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  background: #eef2f7;
  padding: 2px 6px;
  border-radius: 5px;
}
.lib-row {
  display: flex;
  align-items: center;
  gap: 11px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 11px 13px;
  margin-top: 12px;
  font-size: 13px;
}
.lib-row .ok {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--green-ink);
  background: var(--green-bg);
  border: 1px solid var(--green-line);
  border-radius: 8px;
  padding: 5px 10px;
}
.dz-ic {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--accent-line);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
  color: var(--accent);
  font-weight: 800;
}
.dz-or {
  font-size: 12px;
  color: #a39a8b;
  margin-top: 3px;
  font-weight: 600;
}
.dz-btn {
  margin-top: 11px;
  font-family: inherit;
  font-weight: 800;
  font-size: 13px;
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 9px 17px;
  box-shadow: 0 2px 8px rgba(232, 116, 74, 0.28);
}
.lib-search {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f4f1ea;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 12.5px;
  color: #a39a8b;
  margin-top: 14px;
}
.lib-sec {
  font-size: 11.5px;
  font-weight: 800;
  color: #a8987f;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  margin: 20px 0 4px;
}
.lib-ic {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
}
.lib-meta {
  flex: 1;
  min-width: 0;
}
.lib-name {
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 7px;
}
.lib-tag {
  font-size: 10px;
  font-weight: 800;
  color: var(--accent-ink);
  background: var(--accent-bg);
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  padding: 1px 6px;
}
.lib-ver {
  font-size: 11.5px;
  color: #9a9183;
}
.lib-rm {
  margin-left: auto;
  font-family: inherit;
  font-weight: 700;
  font-size: 11.5px;
  color: var(--red-ink);
  background: var(--red-bg);
  border: 1px solid var(--red-line);
  border-radius: 8px;
  padding: 5px 10px;
  cursor: pointer;
}
.dz-btn[disabled],
.lib-rm[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
.canvas-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
.errmsg {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--red-ink);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.buildnotes {
  padding: 4px 8px;
  background: var(--amber-bg, #fff8e6);
  border-top: 1px solid var(--amber-line, #f0d999);
}
.buildnotes p {
  margin: 2px 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--amber-ink, #8a6d1a);
}
.autoscroll {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #6b6459;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.autoscroll input {
  margin: 0;
  cursor: pointer;
}
.log {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
  padding: 12px 14px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--panel-3);
  color: var(--ink-2);
  white-space: pre-wrap;
}

/* ── Responsive (AUD-028): below 900px the 3-pane split can't fit side-by-side, so stack editor → circuit
   → serial in one scrollable column and let the toolbar wrap; mobile tightens paddings. ── */
@media (max-width: 900px) {
  .appbar {
    height: auto;
    min-height: 58px;
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 9px 12px;
  }
  .layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto;
    overflow-y: auto;
    padding: 10px;
    row-gap: 10px;
  }
  .gutter-col,
  .gutter-row {
    display: none; /* no drag-resize when stacked */
  }
  .editor {
    grid-column: 1;
    grid-row: 1;
    min-height: 46vh;
  }
  .circuit {
    grid-column: 1;
    grid-row: 2;
    min-height: 56vh;
  }
  .serial {
    grid-column: 1;
    grid-row: 3;
    min-height: 28vh;
  }
  /* the running status is a single compact node here (runningStatusText); keep it from forcing the
     appbar tall by capping its width + trimming its box (Issue 13 / PR-05). */
  .status {
    max-width: 100%;
    min-width: 0;
    font-size: 12px;
    padding: 5px 10px;
  }
  /* the editor header wraps instead of clipping its tabs/format/hint (Issue 14) */
  .phead {
    flex-wrap: wrap;
    row-gap: 4px;
    height: auto;
    min-height: 44px;
    padding: 6px 12px;
  }
  .phint {
    display: none;
  }
}
@media (max-width: 560px) {
  /* tighten the appbar so a running phone keeps it well under a third of the screen (PR-05) */
  .appbar {
    gap: 6px;
    row-gap: 4px;
    padding: 5px 10px;
  }
  .status {
    font-size: 11.5px;
    padding: 4px 9px;
  }
  .run {
    padding: 6px 13px;
  }
  .icon {
    height: 30px;
    width: 30px;
  }
  .ghost {
    padding: 5px 9px;
  }
  .brandchip {
    display: none; /* the Start-screen footer carries the brand on phones; keep the appbar short (PR-05) */
  }
  .layout {
    padding: 8px;
    row-gap: 8px;
  }
  .editor {
    min-height: 42vh;
  }
  .circuit {
    min-height: 62vh;
  }
}
</style>
