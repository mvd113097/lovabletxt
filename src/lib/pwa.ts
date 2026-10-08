// The ONLY service-worker registrar. Never registers in dev, iframes, or Lovable preview hosts.
export async function setupServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  const h = location.hostname;
  let inFrame = true;
  try {
    inFrame = window.self !== window.top;
  } catch {}
  const refused =
    !import.meta.env.PROD ||
    inFrame ||
    h.startsWith("id-preview--") ||
    h.startsWith("preview--") ||
    /(^|\.)lovableproject(-dev)?\.com$/.test(h) ||
    /(^|\.)beta\.lovable\.dev$/.test(h) ||
    new URLSearchParams(location.search).get("sw") === "off";
  if (refused) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs.filter((r) => (r.active ?? r.installing ?? r.waiting)?.scriptURL.endsWith("/sw.js")).map((r) => r.unregister()),
    );
    return;
  }
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}
