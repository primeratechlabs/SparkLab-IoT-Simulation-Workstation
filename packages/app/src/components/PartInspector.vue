<script setup lang="ts">
/**
 * PartInspector — a data-driven property panel for the selected part. It renders one control per
 * catalog `properties` entry (no per-component code) so every component's editable attributes are
 * exposed: LED colour, resistor Ω, NTC beta/R0, I²C address, relay activeLow, … Edits emit `change`.
 *
 * For an analog sensor (LDR/NTC) wired to an ADC channel it also shows a live stimulus slider — the
 * "sensor behaviour": dragging it injects a raw ADC reading into the running firmware via `stim`.
 */
import { computed } from 'vue';
import { catalogEntry, type PropValue, type PropSpec } from '@sparklab/schematic';
import type { Placed } from '../composables/useCircuitCanvas';

const props = defineProps<{ part: Placed; analogChannel?: number; issues?: string[] }>();
const emit = defineEmits<{ change: [name: string, value: PropValue]; stim: [raw: number] }>();

const specs = computed<PropSpec[]>(() => catalogEntry(props.part.type)?.properties ?? []);
const stim = computed<number>(() => Number(props.part.props._adc ?? 512));

function onChange(spec: PropSpec, e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  let value: PropValue;
  if (spec.control === 'boolean') value = (t as HTMLInputElement).checked;
  else if (spec.control === 'number') {
    const n = Number(t.value);
    if (Number.isNaN(n)) return;
    value = n;
  } else value = t.value;
  emit('change', spec.name, value);
}
</script>

<template>
  <div class="inspector" data-testid="inspector" @pointerdown.stop>
    <div class="ititle">{{ part.type }}</div>
    <label v-for="s in specs" :key="s.name" class="row">
      <span class="lbl">{{ s.label }}</span>
      <select
        v-if="s.control === 'select'"
        :value="String(part.props[s.name])"
        :data-testid="`prop-${s.name}`"
        @change="onChange(s, $event)"
      >
        <option v-for="o in s.options" :key="String(o)" :value="String(o)">{{ o }}</option>
      </select>
      <input
        v-else-if="s.control === 'boolean'"
        type="checkbox"
        :checked="Boolean(part.props[s.name])"
        :data-testid="`prop-${s.name}`"
        @change="onChange(s, $event)"
      />
      <input
        v-else-if="s.control === 'number'"
        type="number"
        :value="Number(part.props[s.name])"
        :min="s.min"
        :max="s.max"
        :step="s.step ?? 1"
        :data-testid="`prop-${s.name}`"
        @input="onChange(s, $event)"
      />
      <input
        v-else
        type="text"
        :value="String(part.props[s.name] ?? '')"
        :data-testid="`prop-${s.name}`"
        @input="onChange(s, $event)"
      />
    </label>

    <label v-if="analogChannel !== undefined" class="row stim">
      <span class="lbl">Tín hiệu cảm biến → A{{ analogChannel }} (ADC {{ stim }})</span>
      <input
        type="range"
        min="0"
        max="1023"
        :value="stim"
        data-testid="sensor-stim"
        @input="emit('stim', Number(($event.target as HTMLInputElement).value))"
      />
    </label>

    <div v-if="!specs.length && analogChannel === undefined" class="empty">
      Linh kiện này không có thuộc tính chỉnh được.
    </div>

    <ul v-if="issues && issues.length" class="issues" data-testid="part-issues">
      <li v-for="msg in issues" :key="msg">⚠ {{ msg }}</li>
    </ul>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 196px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-card, 12px);
  box-shadow: var(--shadow-pop);
  padding: 11px 12px;
}
.ititle {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.row .lbl {
  font-weight: 700;
}
.row input,
.row select {
  font-family: inherit;
  font-size: 12px;
  padding: 5px 7px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: var(--panel);
  color: var(--ink);
}
.row input[type='checkbox'] {
  width: 16px;
  height: 16px;
  align-self: flex-start;
}
.row.stim input[type='range'] {
  padding: 0;
  accent-color: var(--accent);
}
.empty {
  font-size: 11px;
  color: var(--ink-faint);
}
.issues {
  margin: 0;
  padding: 7px 9px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: #fbeae6;
  border: 1px solid #f0cfc6;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  color: #c0452f;
}
</style>
