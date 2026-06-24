<script setup lang="ts">
import { computed } from 'vue';
import { BOARDS, TEMPLATES, boardInfo, type BoardInfo, type StarterTemplate } from '../lib/boards';
import type { SavedCanvas } from '../lib/persist';
import { useCapability } from '../composables/useCapability';
import primeraWordmark from '../assets/brand/primera-wordmark.png';

// Hide any starter template whose board is work-in-progress (e.g. the C3 Blynk demo while the C3 is
// disabled) — it returns automatically when the board is re-enabled.
const selectableTemplates = computed(() => TEMPLATES.filter((t) => !boardInfo(t.boardId)?.wip));

// Real browser-capability badge (AUD-011): no more hard-coded "ready".
const { summary, loading } = useCapability();

// AGPL-3.0 section 13: the deployed app offers users a link to SparkLab's own Corresponding Source.
// Defaults to the public repo; VITE_SOURCE_URL can override it (e.g. to pin a specific tag/branch).
const sourceUrl: string =
  import.meta.env.VITE_SOURCE_URL ||
  'https://github.com/primeratechlabs/SparkLab-IoT-Simulation-Workstation';

// `hasProject` ⇒ there's an in-memory project to go back to (the user left it for the Start screen);
// surface a Resume button so navigating to Start is recoverable (AUD-002).
defineProps<{ hasProject?: boolean }>();

const emit = defineEmits<{
  create: [{ boardId: string; name?: string; sketch?: string; canvas?: SavedCanvas | null }];
  resume: [];
  'open-labs': [];
}>();

function pickBoard(b: BoardInfo): void {
  if (b.wip) return; // a work-in-progress board is shown but not selectable yet
  emit('create', { boardId: b.id });
}
function pickTemplate(t: StarterTemplate): void {
  if (boardInfo(t.boardId)?.wip) return; // a template on a work-in-progress board is not selectable
  // A template carries its circuit too (AUD-005): pass it so the workspace opens with the drawn parts.
  emit('create', { boardId: t.boardId, name: t.id, sketch: t.sketch, canvas: t.canvas ?? null });
}

/** Per-board thumbnail tint. */
function boardTint(id: string): string {
  if (id === 'arduino-uno') return '#0E8C9B';
  return '#23262B';
}
</script>

<template>
  <div class="start">
    <div class="topbar">
      <span class="logo">
        <svg viewBox="0 0 24 24">
          <circle cx="6" cy="18" r="2.4" fill="#fff" />
          <circle cx="18" cy="6" r="2.4" fill="#fff" />
          <path
            d="M7.5 16.5 16.5 7.5"
            fill="none"
            stroke="#fff"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <b>Mạch Ảo</b>
      <span class="sub">IoT Workstation</span>
      <span style="flex: 1"></span>
      <button
        v-if="hasProject"
        class="ghost resume"
        data-testid="resume-project"
        @click="emit('resume')"
      >
        ↩ Tiếp tục dự án
      </button>
      <button class="ghost" data-testid="open-advanced-labs" @click="emit('open-labs')">
        Chế độ nâng cao
      </button>
    </div>

    <div class="body">
      <div class="inner">
        <div class="head">
          <div>
            <div class="hi">Chào bạn mới 👋</div>
            <h1>Bắt đầu một dự án mới</h1>
            <p>
              Chọn bo mạch của bạn. Lập trình và lắp mạch ngay trong trình duyệt — không cần cài đặt
              gì cả.
            </p>
          </div>
          <div
            class="ready"
            :class="{ degraded: summary && !summary.ready, checking: loading }"
            data-testid="capability-badge"
            :title="summary?.limitations.join('\n') || ''"
          >
            <span class="dot"></span
            >{{ loading ? 'Đang kiểm tra trình duyệt…' : (summary?.headline ?? '') }}
          </div>
        </div>

        <div class="boards">
          <button
            v-for="b in BOARDS"
            :key="b.id"
            class="board"
            :class="{ primary: b.id === 'arduino-uno', wip: b.wip }"
            :data-testid="`board-${b.id}`"
            :disabled="b.wip"
            :aria-disabled="b.wip"
            :title="b.wip ? 'Đang phát triển — sẽ sớm có' : undefined"
            @click="pickBoard(b)"
          >
            <div
              class="thumb"
              :style="{ background: b.id === 'arduino-uno' ? '#FBF3EC' : '#F1EFEA' }"
            >
              <span v-if="b.wip" class="wip-badge" data-testid="board-wip">🚧 Đang phát triển</span>
              <span
                class="lvl"
                :style="{
                  background:
                    b.level === 'DỄ NHẤT'
                      ? 'var(--green)'
                      : b.level === 'TRUNG BÌNH'
                        ? 'var(--amber)'
                        : 'var(--red-ink)',
                }"
                >{{ b.level }}</span
              >
              <svg viewBox="0 0 150 92" width="150" height="92">
                <rect x="20" y="22" width="110" height="50" rx="7" :fill="boardTint(b.id)" />
                <rect
                  x="44"
                  y="14"
                  width="62"
                  height="14"
                  rx="3"
                  fill="#C9CDD2"
                  v-if="b.id !== 'arduino-uno'"
                />
                <rect x="88" y="36" width="26" height="22" rx="2" fill="#15181a" />
                <g fill="#00000022">
                  <rect x="34" y="22" width="4" height="5" />
                  <rect x="44" y="22" width="4" height="5" />
                  <rect x="54" y="22" width="4" height="5" />
                  <rect x="64" y="22" width="4" height="5" />
                  <rect x="74" y="22" width="4" height="5" />
                </g>
              </svg>
            </div>
            <div class="meta">
              <div class="name">{{ b.name }}</div>
              <div class="msub">{{ b.sub }}</div>
              <p>{{ b.blurb }}</p>
              <div class="cta" :style="{ color: b.wip ? 'var(--ink-faint)' : b.accent }">
                {{ b.wip ? 'Sắp ra mắt' : 'Tạo dự án →' }}
              </div>
            </div>
          </button>
        </div>

        <div class="templates">
          <div class="t-title">Hoặc mở một ví dụ có sẵn</div>
          <div class="t-grid">
            <button
              v-for="t in selectableTemplates"
              :key="t.id"
              class="tpl"
              :data-testid="`template-${t.id}`"
              @click="pickTemplate(t)"
            >
              <span class="sw" :class="`sw-${t.swatch}`"><i></i></span>
              <div class="tname">{{ t.title }}</div>
              <div class="tsub">{{ t.sub }}</div>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- brand / copyright: SparkLab is a product of Primera Tech Labs -->
    <footer class="brandfoot" data-testid="brand-footer">
      <img class="brandlogo" :src="primeraWordmark" alt="Primera Tech Labs" />
      <div class="brandtext">
        <div class="brandline">
          <b>SparkLab</b> — sản phẩm của <b>Công ty TNHH Primera Tech Labs</b>
        </div>
        <div class="brandcopy">
          © 2026 Primera Tech Labs · Mã nguồn mở (AGPL-3.0) ·
          <a class="brandlink" :href="sourceUrl" target="_blank" rel="noopener">Mã nguồn</a> ·
          <a class="brandlink" href="/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener"
            >Giấy phép &amp; ghi nhận</a
          >
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.start {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--bg);
}
.topbar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  background: var(--dark);
  color: var(--dark-ink);
}
.logo {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.logo svg {
  width: 15px;
  height: 15px;
}
.topbar b {
  font-size: 14px;
  font-weight: 800;
}
.topbar .sub {
  font-size: 11px;
  color: #8c857a;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.ghost {
  background: transparent;
  border: 1px solid #ffffff22;
  color: #cfc8bc;
  font-family: inherit;
  font-weight: 700;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 48px 40px 56px;
}
.inner {
  max-width: 1040px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px;
}
.hi {
  font-size: 13px;
  font-weight: 700;
  color: #a8987f;
}
.head h1 {
  margin: 6px 0 0;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.6px;
}
.head p {
  margin: 10px 0 0;
  font-size: 15.5px;
  color: var(--ink-soft);
  max-width: 520px;
  line-height: 1.55;
}
.ready {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--green-ink);
  box-shadow: var(--shadow-card);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--green);
  animation: pulsedot 2s ease-in-out infinite;
}
/* Degraded capability (cached-only / preview-only) — amber, honest about the limitation. */
.ready.degraded {
  color: var(--amber-ink, #8a5a00);
}
.ready.degraded .dot {
  background: var(--amber, #e0a000);
}
/* While the capability probe runs. */
.ready.checking {
  color: var(--ink-soft, #667);
}
.ready.checking .dot {
  background: var(--line, #aab);
}
.boards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-top: 30px;
}
.board {
  text-align: left;
  cursor: pointer;
  background: var(--panel);
  border: 1.5px solid var(--line-2);
  border-radius: var(--r-lg);
  padding: 0;
  overflow: hidden;
  font-family: inherit;
  box-shadow: var(--shadow-card);
}
.board.primary {
  border-color: var(--accent);
  box-shadow:
    0 2px 4px rgba(40, 35, 28, 0.05),
    0 14px 30px rgba(232, 116, 74, 0.1);
}
.thumb {
  height: 128px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.lvl {
  position: absolute;
  top: 12px;
  left: 12px;
  font-size: 11px;
  font-weight: 800;
  color: #fff;
  padding: 4px 9px;
  border-radius: var(--r-pill);
}
.meta {
  padding: 16px 18px 18px;
}
.name {
  font-size: 18px;
  font-weight: 800;
}
.msub {
  font-size: 13px;
  color: var(--ink-muted);
  margin-top: 3px;
  font-weight: 600;
}
.meta p {
  font-size: 13px;
  color: #857c70;
  margin: 11px 0 0;
  line-height: 1.5;
}
.cta {
  display: inline-flex;
  margin-top: 14px;
  font-size: 13.5px;
  font-weight: 800;
}
.templates {
  margin-top: 40px;
}
.t-title {
  font-size: 13px;
  font-weight: 800;
  color: #a8987f;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.t-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-top: 14px;
}
.tpl {
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 14px;
  padding: 15px;
  box-shadow: var(--shadow-card);
}
.sw {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sw i {
  display: block;
}
.sw-led {
  background: #fbe9df;
}
.sw-led i {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
}
.sw-button {
  background: #e6f0e9;
}
.sw-button i {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: var(--green);
}
.sw-pot {
  background: #e4ecf7;
}
.sw-pot i {
  width: 18px;
  height: 8px;
  border-radius: 4px;
  background: var(--blue);
}
.sw-lcd {
  background: #f6ecda;
}
.sw-lcd i {
  width: 16px;
  height: 11px;
  border-radius: 2px;
  border: 2px solid var(--amber-ink);
}
.sw-wifi {
  background: #e2ecf7;
}
.sw-wifi i {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--blue, #1c7ed6);
  border-bottom-color: transparent;
  border-left-color: transparent;
  transform: rotate(-45deg);
}
.tname {
  font-weight: 700;
  font-size: 14px;
  margin-top: 11px;
}
.tsub {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 2px;
}

/* ── Responsive (AUD-028): collapse the board + template grids and let the top bar wrap on narrow screens. ── */
/* work-in-progress board: visible but not selectable */
.board.wip {
  cursor: not-allowed;
  opacity: 0.62;
  filter: grayscale(0.35);
}
.board.wip:hover {
  transform: none;
  box-shadow: none;
}
.wip-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: #fff;
  background: #b9770a;
  padding: 3px 8px;
  border-radius: 999px;
}

/* brand / copyright footer — SparkLab is a product of Primera Tech Labs */
.brandfoot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 22px;
  border-top: 1px solid var(--line, #e4e0d7);
  background: var(--panel, #fff);
}
.brandlogo {
  height: 30px;
  width: auto;
  display: block;
}
.brandtext {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.35;
}
.brandline {
  font-size: 13px;
  color: var(--ink, #1a1a1a);
}
.brandcopy {
  font-size: 11.5px;
  color: var(--ink-faint, #8a8580);
}
.brandlink {
  color: inherit;
  text-decoration: underline;
}
.brandlink:hover {
  color: var(--ink, #1a1a1a);
}

@media (max-width: 760px) {
  .topbar {
    height: auto;
    min-height: 52px;
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 8px 14px;
  }
  .boards {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  .t-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 460px) {
  .boards,
  .t-grid {
    grid-template-columns: 1fr;
  }
}
</style>
