<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { CapabilityProfile } from '@sparklab/shared';
import { ensureInit, type SessionInfo } from '../lib/session.js';
import { getStorage } from '../lib/storage-client.js';

const profile = ref<CapabilityProfile | null>(null);
const session = ref<SessionInfo | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

function fmt(n: number | null, unit = ''): string {
  return n == null ? '—' : `${Math.round(n * 10) / 10}${unit}`;
}

onMounted(async () => {
  try {
    session.value = await ensureInit();
    profile.value = await getStorage().profile();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});

function downloadProfile(): void {
  if (!profile.value) return;
  const blob = new Blob([JSON.stringify(profile.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'capability-profile.json';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section>
    <div v-if="loading" data-testid="profile-loading" class="card">
      Profiling browser capabilities…
    </div>

    <div v-else-if="error" class="card banner warn" data-testid="profile-error">
      {{ error }}
    </div>

    <template v-else-if="profile">
      <div class="card">
        <div class="row-actions">
          <span>Capability Tier:</span>
          <span class="badge" data-testid="tier-badge">{{ profile.tier }}</span>
          <button class="action" data-testid="download-profile" @click="downloadProfile">
            Download capability-profile.json
          </button>
        </div>
        <p data-testid="profile-ready" hidden>ready</p>
      </div>

      <div class="card">
        <h3>Platform</h3>
        <dl class="kv">
          <dt>Browser</dt>
          <dd>{{ profile.browser.brand }} {{ profile.browser.version }}</dd>
          <dt>crossOriginIsolated</dt>
          <dd data-testid="cap-coi">{{ profile.crossOriginIsolated }}</dd>
          <dt>SharedArrayBuffer</dt>
          <dd data-testid="cap-sab">{{ profile.sharedArrayBuffer }}</dd>
          <dt>Atomics</dt>
          <dd>{{ profile.atomics }}</dd>
          <dt>OPFS</dt>
          <dd data-testid="cap-opfs">{{ profile.opfs }}</dd>
          <dt>WASM threads</dt>
          <dd>{{ profile.wasmThreads }}</dd>
          <dt>WASM SIMD</dt>
          <dd>{{ profile.wasmSimd }}</dd>
          <dt>OffscreenCanvas</dt>
          <dd>{{ profile.offscreenCanvas }}</dd>
          <dt>WebGPU</dt>
          <dd>{{ profile.webgpu }}</dd>
          <dt>hardwareConcurrency</dt>
          <dd>{{ profile.hardwareConcurrency }}</dd>
          <dt>deviceMemory (GB)</dt>
          <dd>{{ profile.deviceMemoryGB ?? '—' }}</dd>
          <dt>storage quota</dt>
          <dd>{{ profile.storageQuotaBytes ?? '—' }}</dd>
          <dt>persisted</dt>
          <dd>{{ profile.storagePersisted }}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Benchmarks</h3>
        <dl class="kv">
          <dt>WASM instantiate (50MB)</dt>
          <dd data-testid="bench-wasm">{{ fmt(profile.wasmInstantiateMsFor50MB, ' ms') }}</dd>
          <dt>OPFS write</dt>
          <dd data-testid="bench-opfs-write">{{ fmt(profile.opfsWriteMBps, ' MB/s') }}</dd>
          <dt>OPFS read</dt>
          <dd data-testid="bench-opfs-read">{{ fmt(profile.opfsReadMBps, ' MB/s') }}</dd>
        </dl>
        <p v-if="session" class="kv">
          <small
            >fs backend: <code data-testid="fs-backend">{{ session.fsBackend }}</code> · index
            backend: <code>{{ session.indexBackend }}</code></small
          >
        </p>
      </div>

      <div class="card">
        <h3>Raw profile</h3>
        <pre data-testid="profile-json">{{ JSON.stringify(profile, null, 2) }}</pre>
      </div>
    </template>
  </section>
</template>
