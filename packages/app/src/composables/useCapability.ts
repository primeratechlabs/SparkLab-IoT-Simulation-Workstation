/**
 * Capability profile for the PRODUCT (AUD-011). The profiler/planner used to live only in the Capability
 * Lab, while the product hard-coded "Trình duyệt sẵn sàng mô phỏng" regardless of what the browser can
 * actually do. This composable runs the SAME `collectCapabilityProfile` + `planExecution` once at startup
 * (a shared singleton), so the Start screen tells the truth before the user invests effort, and the rest
 * of the app can read one agreed execution plan.
 *
 * `summarizeCapability` is a pure mapping (profile + plan → user-facing summary) so it unit-tests without
 * a browser; the composable is the thin reactive wrapper around it.
 */
import { ref, shallowRef, onMounted } from 'vue';
import { collectCapabilityProfile, planExecution } from '@sparklab/capability';
import type { CapabilityProfile, CapabilityTier, ExecutionPlan } from '@sparklab/shared';

export interface CapabilitySummary {
  tier: CapabilityTier;
  buildMode: ExecutionPlan['buildMode'];
  threaded: boolean;
  /** Full client-side firmware build is available (vs cached-only / preview-only). */
  ready: boolean;
  /** Short Vietnamese status line for the badge. */
  headline: string;
  /** Specific, honest limitations of THIS browser (empty when fully capable). */
  limitations: string[];
}

/** Map a capability profile + execution plan to the user-facing summary (pure — no browser, no I/O). */
export function summarizeCapability(
  profile: CapabilityProfile,
  plan: ExecutionPlan,
): CapabilitySummary {
  const ready = plan.buildMode === 'client-native-wasm-compile';
  const threaded = plan.toolchainVariant === 'threaded';

  const limitations: string[] = [];
  if (!profile.crossOriginIsolated || !profile.sharedArrayBuffer || !profile.atomics) {
    limitations.push(
      'Thiếu cross-origin isolation (COOP/COEP) → toolchain chạy đơn luồng, build chậm hơn.',
    );
  }
  if (!profile.opfs) {
    limitations.push(
      'Trình duyệt không có OPFS → không lưu được pack/cache bền; chỉ xem trước hoặc firmware nhỏ.',
    );
  }
  if (!profile.wasmSimd) {
    limitations.push('WASM SIMD không khả dụng → một vài phần mô phỏng chậm hơn.');
  }

  let headline: string;
  if (ready && threaded) headline = 'Trình duyệt sẵn sàng mô phỏng đầy đủ';
  else if (ready) headline = 'Sẵn sàng — build đơn luồng (chậm hơn)';
  else if (plan.buildMode === 'cached-firmware')
    headline = 'Hạn chế — chỉ chạy firmware đã lưu sẵn';
  else headline = 'Chế độ xem trước — trình duyệt thiếu tính năng để build firmware';

  return { tier: profile.tier, buildMode: plan.buildMode, threaded, ready, headline, limitations };
}

// One profile per session, shared across every consumer (AUD-011: a single execution plan for the app).
let cached: Promise<{ profile: CapabilityProfile; plan: ExecutionPlan }> | null = null;
export function capabilityOnce(): Promise<{ profile: CapabilityProfile; plan: ExecutionPlan }> {
  return (cached ??= (async () => {
    const profile = await collectCapabilityProfile();
    return { profile, plan: planExecution(profile) };
  })());
}

/** Reset the cached profile — tests only. */
export function __resetCapabilityCache(): void {
  cached = null;
}

export function useCapability() {
  const summary = shallowRef<CapabilitySummary | null>(null);
  const loading = ref(true);

  onMounted(async () => {
    try {
      const { profile, plan } = await capabilityOnce();
      summary.value = summarizeCapability(profile, plan);
    } catch {
      // Detection failure → controlled degradation: present as preview-only rather than a false "ready".
      summary.value = {
        tier: 'D',
        buildMode: 'preview',
        threaded: false,
        ready: false,
        headline: 'Không kiểm tra được năng lực trình duyệt — tạm ở chế độ xem trước',
        limitations: ['Không thu thập được capability profile.'],
      };
    } finally {
      loading.value = false;
    }
  });

  return { summary, loading };
}
