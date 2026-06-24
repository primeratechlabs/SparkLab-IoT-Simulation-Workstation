<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import StartScreen from './components/StartScreen.vue';
import WorkspaceShell from './components/WorkspaceShell.vue';
import AdvancedLabs from './components/AdvancedLabs.vue';
import { useAppView } from './composables/useAppView';

// Deep-link ?view=labs wins; otherwise useAppView restores the autosaved project (reload keeps the
// user's work); a first-ever visit lands on the board picker.
const isLabs =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'labs';
const { view, project, createProject, resume, openLabs, closeLabs, goStart, hasProject } =
  useAppView({ isLabs });

// Top-level error boundary: a throw in any view (render/lifecycle) shows an actionable fallback instead
// of blanking the whole page. Returning false stops propagation (we've already surfaced it here).
const fatalError = ref<string | null>(null);
onErrorCaptured((err) => {
  console.error('[sparklab] view error:', err);
  fatalError.value = err instanceof Error ? err.message : String(err);
  return false;
});
function reload(): void {
  if (typeof location !== 'undefined') location.reload();
}

// PWA: register the service worker (installable + offline-after-first-use). registerType is 'prompt',
// so a new version waits and we surface a non-blocking banner — never a reload mid-compile. In dev (PWA
// disabled) this is an inert stub. `needRefresh` flips true when an updated SW is ready to take over.
const { needRefresh, updateServiceWorker } = useRegisterSW({ immediate: true });
const updating = ref(false);
/**
 * Activate the waiting service worker + reload onto the new version. We do NOT rely solely on the
 * plugin's `updateServiceWorker(true)` — in production it can silently no-op (its internal registration
 * handle goes stale), which is exactly the "click does nothing" symptom. So we message the waiting worker
 * DIRECTLY (it skips waiting on `SKIP_WAITING`) and reload the moment control changes, with a grace-period
 * fallback. The fresh index.html is not edge-cached, so a reload always pulls the new shell.
 */
async function applyUpdate(): Promise<void> {
  if (updating.value) return;
  updating.value = true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    location.reload();
    return;
  }
  let reloaded = false;
  const reload = (): void => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reload);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg?.waiting)
      reg.waiting.postMessage({ type: 'SKIP_WAITING' }); // the waiting SW takes over → controllerchange
    else await updateServiceWorker(true); // no waiting worker cached — let the plugin re-check + activate
  } catch {
    void updateServiceWorker(true).catch(() => {});
  }
  window.setTimeout(reload, 3500); // last resort if control never hands over (stuck/already-active SW)
}
function dismissUpdate(): void {
  needRefresh.value = false;
}
</script>

<template>
  <div v-if="fatalError" class="fatal" data-testid="app-fatal">
    <div class="fatal-card">
      <h1>Đã xảy ra lỗi</h1>
      <p>
        Giao diện gặp sự cố ngoài dự kiến. Hãy tải lại trang — dự án của bạn đã được lưu tự động.
      </p>
      <pre>{{ fatalError }}</pre>
      <button type="button" @click="reload">Tải lại trang</button>
    </div>
  </div>
  <StartScreen
    v-else-if="view === 'start'"
    :has-project="hasProject()"
    @create="createProject"
    @resume="resume"
    @open-labs="openLabs"
  />
  <WorkspaceShell
    v-else-if="view === 'workspace' && project"
    :board-id="project.boardId"
    :name="project.name"
    :initial-sketch="project.sketch"
    :initial-canvas="project.canvas"
    @back="goStart"
    @open-labs="openLabs"
  />
  <AdvancedLabs v-else @back="closeLabs" />

  <div v-if="needRefresh" class="pwa-update" data-testid="pwa-update" role="status">
    <span>{{ updating ? 'Đang cập nhật…' : 'Có bản cập nhật SparkLab mới.' }}</span>
    <button type="button" class="pwa-apply" :disabled="updating" @click="applyUpdate">
      {{ updating ? '…' : 'Cập nhật' }}
    </button>
    <button
      v-if="!updating"
      type="button"
      class="pwa-dismiss"
      aria-label="Để sau"
      @click="dismissUpdate"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
.fatal {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #f8f6f1;
  color: #1a1a1a;
}
.fatal-card {
  max-width: 520px;
  background: #fff;
  border: 1px solid #e6e1d8;
  border-radius: 16px;
  padding: 26px 28px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
}
.fatal-card h1 {
  margin: 0 0 10px;
  font-size: 20px;
}
.fatal-card p {
  margin: 0 0 14px;
  line-height: 1.6;
}
.fatal-card pre {
  margin: 0 0 16px;
  padding: 12px 14px;
  background: #f3f0ea;
  border-radius: 10px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.fatal-card button {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 10px 18px;
  background: #1a1a1a;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.pwa-update {
  position: fixed;
  z-index: 50;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 24px);
  padding: 10px 12px 10px 16px;
  background: #1a1a1a;
  color: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  font-size: 13.5px;
}
.pwa-update .pwa-apply {
  appearance: none;
  border: 0;
  border-radius: 8px;
  padding: 7px 14px;
  background: #fff;
  color: #1a1a1a;
  font-weight: 700;
  cursor: pointer;
}
.pwa-update .pwa-dismiss {
  appearance: none;
  border: 0;
  background: transparent;
  color: #cfcabf;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 6px;
}
</style>
