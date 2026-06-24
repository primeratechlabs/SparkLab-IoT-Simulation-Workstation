<script setup lang="ts">
/**
 * Brand loading indicator — the Primera Tech Labs animation shown wherever the app waits on async work
 * (compile/build, toolchain download, library upload/install, lazy-loading the canvas). The GIF is a
 * light-background 454×136 loop (3s, transparent), so it composites on the app's light panels and the
 * dimmed overlay backdrop. Self-hosted (bundled), no third-party. `overlay` covers the parent (which
 * must be `position: relative`); otherwise it renders inline.
 */
import loadingGif from '../assets/brand/primera-loading.gif';

withDefaults(
  defineProps<{
    /** primary line under the animation (e.g. "Đang biên dịch…"). */
    label?: string;
    /** secondary, fainter line (e.g. "Lần đầu tải bộ công cụ ~100MB…"). */
    sub?: string;
    /** animation width in px (native is 454×136). */
    width?: number;
    /** cover the (relatively-positioned) parent with a dimmed backdrop instead of rendering inline. */
    overlay?: boolean;
  }>(),
  { width: 180, overlay: false },
);
</script>

<template>
  <div
    class="ploader"
    :class="{ overlay }"
    role="status"
    aria-live="polite"
    data-testid="primera-loader"
  >
    <img :src="loadingGif" :style="{ width: `${width}px` }" alt="Đang tải…" draggable="false" />
    <div v-if="label" class="pl-label">{{ label }}</div>
    <div v-if="sub" class="pl-sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.ploader {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
}
.ploader img {
  height: auto;
  max-width: 100%;
  display: block;
  user-select: none;
}
.pl-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink, #1a1a1a);
}
.pl-sub {
  font-size: 11.5px;
  color: var(--ink-faint, #8a8580);
  max-width: 280px;
}
.ploader.overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  justify-content: center;
  gap: 10px;
  background: rgba(248, 246, 241, 0.88);
  backdrop-filter: blur(1.5px);
}
</style>
