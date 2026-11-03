<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Service worker only via vite-plugin-pwa generateSW, registered solely from src/lib/pwa.ts (guarded off in dev/preview) — avoids stale previews.
- Translation chunks come from packChunks in translate.server.ts — keeps requests minimal and ordered.
- Own-key translation uses distinct stable Flash-Lite model IDs only, newer first; exclude full Flash and duplicate aliases to avoid tighter or shared fallback quotas.
- Own-key dispatch rotates tie-breaking order and synchronously reserves each key's next request slot across chapters/models; explicit invalid/expired credential responses exclude that key for the runtime lifetime, while model permissions and quota failures stay scoped cooldowns — prevents contention without treating temporary failures as invalid credentials.
