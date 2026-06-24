<script setup lang="ts">
// The original engine-surface labs (Stages 0–7), preserved verbatim behind the new product UI as an
// "advanced / debug" view. Keeps every data-testid the e2e suite relies on. Reachable via the app's
// Advanced button or ?view=labs.
import { ref } from 'vue';
import CapabilityLab from './CapabilityLab.vue';
import PackLab from './PackLab.vue';
import BuildLab from './BuildLab.vue';
import SimLab from './SimLab.vue';
import WorkbenchLab from './WorkbenchLab.vue';
import NetworkLab from './NetworkLab.vue';

defineEmits<{ back: [] }>();

type Tab = 'capability' | 'pack' | 'build' | 'sim' | 'workbench' | 'network';
const tab = ref<Tab>('capability');
const coi = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
</script>

<template>
  <div class="shell labs-shell">
    <header>
      <div style="display: flex; align-items: center; gap: 12px">
        <button class="back-link" data-testid="labs-back" @click="$emit('back')">← Mạch Ảo</button>
        <h1>Advanced labs</h1>
      </div>
      <p class="tagline">
        Browser-native IoT build, simulation, and workbench labs (engine surfaces)
      </p>
      <div v-if="!coi" class="banner warn" data-testid="coi-banner">
        ⚠ Not cross-origin isolated — threaded WASM / SharedArrayBuffer / OPFS sync disabled.
        Running in degraded single-thread mode.
      </div>
      <div v-else class="banner ok" data-testid="coi-banner-ok">
        ✓ Cross-origin isolated — full workstation capabilities available.
      </div>
      <nav>
        <button
          :class="{ active: tab === 'capability' }"
          data-testid="tab-capability"
          @click="tab = 'capability'"
        >
          Capability Lab
        </button>
        <button :class="{ active: tab === 'pack' }" data-testid="tab-pack" @click="tab = 'pack'">
          Pack Lab
        </button>
        <button :class="{ active: tab === 'build' }" data-testid="tab-build" @click="tab = 'build'">
          Build Lab
        </button>
        <button :class="{ active: tab === 'sim' }" data-testid="tab-sim" @click="tab = 'sim'">
          Sim Lab
        </button>
        <button
          :class="{ active: tab === 'workbench' }"
          data-testid="tab-workbench"
          @click="tab = 'workbench'"
        >
          Workbench
        </button>
        <button
          :class="{ active: tab === 'network' }"
          data-testid="tab-network"
          @click="tab = 'network'"
        >
          Network Lab
        </button>
      </nav>
    </header>

    <main>
      <CapabilityLab v-show="tab === 'capability'" />
      <PackLab v-show="tab === 'pack'" />
      <BuildLab v-show="tab === 'build'" />
      <SimLab v-show="tab === 'sim'" />
      <WorkbenchLab v-if="tab === 'workbench'" />
      <NetworkLab v-if="tab === 'network'" />
    </main>
  </div>
</template>

<style>
/* Global utility classes the lab components rely on (kept non-scoped on purpose). */
.shell {
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 1.25rem;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: #1a1a1a;
}
.shell h1 {
  margin: 0;
  font-size: 1.4rem;
}
.back-link {
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  font-weight: 600;
}
.tagline {
  margin: 0.25rem 0 0.75rem;
  opacity: 0.7;
}
.banner {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  margin: 0.5rem 0;
  font-size: 0.9rem;
}
.banner.warn {
  background: #fff4e5;
  color: #7a3e00;
}
.banner.ok {
  background: #e7f7ed;
  color: #115c2e;
}
.labs-shell nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.labs-shell nav button {
  padding: 0.4rem 0.9rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.labs-shell nav button.active {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
.card {
  border: 1px solid #ddd;
  border-radius: 10px;
  padding: 1rem;
  margin-top: 1rem;
  background: #fff;
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  font-size: 0.9rem;
}
.kv dt {
  font-weight: 600;
}
.kv dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.labs-shell pre {
  max-width: 100%;
  background: #0b1021;
  color: #d6e2ff;
  padding: 0.75rem;
  border-radius: 8px;
  overflow: auto;
  font-size: 0.78rem;
}
.badge {
  display: inline-block;
  padding: 0.1rem 0.6rem;
  border-radius: 999px;
  font-weight: 700;
  background: #2563eb;
  color: white;
}
.labs-shell button.action {
  padding: 0.45rem 0.9rem;
  border-radius: 6px;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: white;
  cursor: pointer;
}
.labs-shell button.action[disabled] {
  opacity: 0.5;
  cursor: default;
}
.progress {
  height: 8px;
  background: #e5e7eb;
  border-radius: 999px;
  overflow: hidden;
  margin: 0.5rem 0;
}
.progress > div {
  height: 100%;
  background: #16a34a;
}
.labs-shell table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.labs-shell th,
.labs-shell td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid #eee;
}
.row-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
</style>
