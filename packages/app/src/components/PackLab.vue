<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { StorageHealth, InstallProgress } from '@sparklab/pack-manager';
import {
  ensureInit,
  loadTrustedKeysHex,
  SAMPLE_PACK_BASE_URL,
  type SessionInfo,
} from '../lib/session.js';
import { getStorage, proxyCallback } from '../lib/storage-client.js';

const session = ref<SessionInfo | null>(null);
const health = ref<StorageHealth | null>(null);
const installStatus = ref<'idle' | 'installing' | 'installed' | 'reused' | 'error'>('idle');
const progressFraction = ref(0);
const progressPhase = ref('');
const errorMsg = ref<string | null>(null);
const probeInput = ref('hello-sparklab');
const probeValue = ref<string | null>(null);
const probeSaved = ref(false);

async function refreshHealth(): Promise<void> {
  health.value = await getStorage().health();
}

onMounted(async () => {
  session.value = await ensureInit();
  await refreshHealth();
  probeValue.value = await getStorage().getProbe();
});

async function install(): Promise<void> {
  errorMsg.value = null;
  installStatus.value = 'installing';
  progressFraction.value = 0;
  try {
    const keys = await loadTrustedKeysHex();
    const onProgress = proxyCallback((p: InstallProgress) => {
      progressPhase.value = p.phase;
      progressFraction.value = p.filesTotal ? p.filesDone / p.filesTotal : 1;
    });
    const result = await getStorage().installSamplePack(SAMPLE_PACK_BASE_URL, keys, onProgress);
    installStatus.value = result.reused ? 'reused' : 'installed';
    progressFraction.value = 1;
    await refreshHealth();
  } catch (e) {
    installStatus.value = 'error';
    errorMsg.value = (e as Error).message;
  }
}

async function evict(): Promise<void> {
  await getStorage().evictSamplePack();
  installStatus.value = 'idle';
  progressFraction.value = 0;
  await refreshHealth();
}

async function setProbe(): Promise<void> {
  probeSaved.value = false;
  await getStorage().setProbe(probeInput.value);
  probeSaved.value = true;
}
async function getProbe(): Promise<void> {
  probeValue.value = await getStorage().getProbe();
}
</script>

<template>
  <section>
    <div class="card">
      <div class="row-actions">
        <button
          class="action"
          data-testid="install-btn"
          :disabled="installStatus === 'installing'"
          @click="install"
        >
          Install sample pack (≥50MB)
        </button>
        <button class="action" data-testid="reload-health-btn" @click="refreshHealth">
          Reload health
        </button>
        <button class="action" data-testid="evict-btn" @click="evict">Evict</button>
        <span data-testid="install-status">{{ installStatus }}</span>
      </div>

      <div class="progress">
        <div
          data-testid="install-progress"
          :style="{ width: `${Math.round(progressFraction * 100)}%` }"
        />
      </div>
      <small v-if="progressPhase">phase: {{ progressPhase }}</small>

      <p v-if="errorMsg" class="banner warn" data-testid="install-error">
        {{ errorMsg }}
      </p>
    </div>

    <div class="card">
      <h3>Storage health</h3>
      <dl v-if="health" class="kv">
        <dt>Installed packs</dt>
        <dd data-testid="pack-count">{{ health.packCount }}</dd>
        <dt>Total pack bytes</dt>
        <dd data-testid="health-total">{{ health.totalPackBytes }}</dd>
        <dt>Missing packs</dt>
        <dd data-testid="health-missing">{{ health.missing.length }}</dd>
        <dt>Persisted</dt>
        <dd data-testid="health-persisted">{{ health.quota.persisted }}</dd>
        <dt>Storage usage</dt>
        <dd>{{ health.quota.usageBytes ?? '—' }} / {{ health.quota.quotaBytes ?? '—' }}</dd>
        <dt>Index backend</dt>
        <dd data-testid="index-backend">{{ session?.indexBackend ?? '—' }}</dd>
      </dl>

      <table v-if="health && health.packs.length">
        <thead>
          <tr>
            <th>Name</th>
            <th>Version</th>
            <th>Type</th>
            <th>Bytes</th>
            <th>Present</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in health.packs" :key="`${p.name}@${p.version}`" data-testid="pack-row">
            <td>{{ p.name }}</td>
            <td>{{ p.version }}</td>
            <td>{{ p.packType }}</td>
            <td>{{ p.sizeBytes }}</td>
            <td>{{ p.present }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Index persistence probe</h3>
      <div class="row-actions">
        <input v-model="probeInput" data-testid="probe-input" />
        <button class="action" data-testid="probe-set-btn" @click="setProbe">Set</button>
        <button class="action" data-testid="probe-get-btn" @click="getProbe">Get</button>
        <span
          >value: <code data-testid="probe-value">{{ probeValue ?? '∅' }}</code></span
        >
        <span v-if="probeSaved" data-testid="probe-saved">saved</span>
      </div>
      <small>Set a value, reload the page, then Get — proves the index persists.</small>
    </div>
  </section>
</template>
