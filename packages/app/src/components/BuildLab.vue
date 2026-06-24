<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { BuildOutcome } from '@sparklab/build-orchestrator';
import { getBuild } from '../lib/build-client.js';

const backend = ref<{ fsBackend: string; indexBackend: string } | null>(null);
const outcome = ref<BuildOutcome | null>(null);
const busy = ref(false);
const ready = ref(false);

onMounted(async () => {
  backend.value = await getBuild().init();
  await getBuild().setupSampleProject();
  ready.value = true;
});

async function build(): Promise<void> {
  busy.value = true;
  try {
    outcome.value = await getBuild().build();
  } finally {
    busy.value = false;
  }
}

async function editAndBuild(): Promise<void> {
  await getBuild().editMain();
  await build();
}

async function resetProject(): Promise<void> {
  await getBuild().setupSampleProject();
  outcome.value = null;
}
</script>

<template>
  <section>
    <div class="card">
      <div class="row-actions">
        <button class="action" data-testid="build-btn" :disabled="busy || !ready" @click="build">
          Build
        </button>
        <button
          class="action"
          data-testid="edit-build-btn"
          :disabled="busy || !ready"
          @click="editAndBuild"
        >
          Edit main.cpp &amp; rebuild
        </button>
        <button
          class="action"
          data-testid="reset-project-btn"
          :disabled="busy || !ready"
          @click="resetProject"
        >
          Reset project
        </button>
      </div>
      <small v-if="backend">
        fs: <code>{{ backend.fsBackend }}</code> · index: <code>{{ backend.indexBackend }}</code>
      </small>
      <p class="mode" data-testid="build-mode-label">
        Toolchain: stub (deterministic) — produces a placeholder ELF, NOT runnable AVR firmware yet.
        Real avr-gcc.wasm pending (Stage 2). Timing: N/A (build pipeline only).
      </p>
    </div>

    <div v-if="outcome" class="card">
      <h3>Last build</h3>
      <dl class="kv">
        <dt>Compiled units</dt>
        <dd data-testid="build-compiled">{{ outcome.compiledUnitIds.join(', ') || '—' }}</dd>
        <dt>Reused units</dt>
        <dd data-testid="build-reused">{{ outcome.reusedUnitIds.join(', ') || '—' }}</dd>
        <dt>ELF valid</dt>
        <dd data-testid="build-elf-valid">{{ outcome.elfValid }}</dd>
        <dt>Firmware key</dt>
        <dd data-testid="build-firmware-key">{{ outcome.firmwareKey ?? '—' }}</dd>
        <dt>From firmware cache</dt>
        <dd data-testid="build-from-cache">{{ outcome.fromFirmwareCache }}</dd>
        <dt>Toolchain instantiations</dt>
        <dd data-testid="build-instantiations">{{ outcome.toolchainInstantiations }}</dd>
        <dt>Diagnostics</dt>
        <dd data-testid="build-diagnostics">{{ outcome.diagnostics.length }}</dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.mode {
  font-size: 0.82rem;
  color: #7a3e00;
  margin: 0.4rem 0 0;
}
</style>
