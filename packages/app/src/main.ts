import { createApp } from 'vue';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
import './theme.css';
import App from './App.vue';

/**
 * Cross-origin isolation is load-bearing: the in-browser compiler + MCU emulator need SharedArrayBuffer
 * (threaded WASM / OPFS sync access handles), which the browser grants ONLY when the page is served with
 * `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` over a secure
 * context (HTTPS or localhost). A deploy that omits those silently loses `crossOriginIsolated` and the
 * whole engine breaks. Rather than mount a half-broken app that fails cryptically on the first compile,
 * detect it up front and render an actionable diagnostic. (On a correct deploy this branch never runs.)
 */
function renderIsolationDiagnostic(): void {
  const host = document.getElementById('app') ?? document.body;
  host.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
                font-family:'Plus Jakarta Sans Variable',system-ui,sans-serif;background:#f8f6f1;color:#1a1a1a">
      <div style="max-width:560px;background:#fff;border:1px solid #e6e1d8;border-radius:16px;padding:28px 30px;
                  box-shadow:0 8px 30px rgba(0,0,0,.06)">
        <h1 style="margin:0 0 10px;font-size:20px">⚠️ Trình duyệt chưa được cách ly (cross-origin isolation)</h1>
        <p style="margin:0 0 14px;line-height:1.6">
          SparkLab cần <b>SharedArrayBuffer</b> để biên dịch và mô phỏng ngay trong trình duyệt. Tính năng này
          chỉ bật khi máy chủ trả về đủ các HTTP header sau (và chạy qua <b>HTTPS</b>):
        </p>
        <pre style="margin:0 0 14px;padding:12px 14px;background:#f3f0ea;border-radius:10px;overflow:auto;
                    font-family:'JetBrains Mono Variable',ui-monospace,monospace;font-size:12.5px;line-height:1.5">Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin</pre>
        <p style="margin:0 0 6px;line-height:1.6">
          Nếu bạn vừa deploy lên VPS/aaPanel: dán cấu hình trong <code>deploy/aapanel-nginx.conf</code> vào
          site, bật <b>Force HTTPS</b>, rồi tải lại trang.
        </p>
        <p style="margin:0;color:#6b6256;font-size:13px">— Công ty TNHH Primera Tech Labs</p>
      </div>
    </div>`;
}

// Surface async failures that escape a try/catch (worker init, fire-and-forget promises) instead of
// letting them vanish silently in production. Complements app.config.errorHandler (sync render errors).
function installGlobalErrorHandlers(): void {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[sparklab] unhandled promise rejection:', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[sparklab] uncaught error:', e.error ?? e.message);
  });
}

installGlobalErrorHandlers();

if (typeof self !== 'undefined' && self.crossOriginIsolated === false) {
  renderIsolationDiagnostic();
} else {
  const app = createApp(App);
  app.config.errorHandler = (err, _instance, info) => {
    // Keep the page alive and leave a breadcrumb; the in-component boundary renders the visible fallback.
    console.error('[sparklab] unhandled component error:', err, info);
  };
  app.mount('#app');
}
