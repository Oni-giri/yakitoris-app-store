# Yakitori's Umbrel App Store

Self-hosted apps for people and AI agents on [umbrelOS](https://umbrel.com/).

## Add to Umbrel

1. Open the **App Store** on your Umbrel.
2. Click the **`···`** menu in the top-right corner and choose **Community App Stores**.
3. Paste this repository URL and click **Add**:

```text
https://github.com/Oni-giri/yakitoris-app-store
```

## Included Apps

| App | ID | Category | Port | Arch | Summary |
| --- | --- | --- | --- | --- | --- |
| [Anki Sync Hub](https://github.com/Oni-giri/anki-sync-hub) | `yakitori-anki-sync-hub` | Automation | `8723` | `amd64`, `arm64` | Private Anki sync service with a browser admin UI, REST API, and scoped MCP server |
| [ARTEX](https://github.com/BaaRai/ARTEX) | `yakitori-artex` | Developer | `8787` | `amd64` | Autonomous multi-agent penetration testing platform with evidence-bound findings |
| [BrowserPier](https://github.com/Oni-giri/browser-pier) | `yakitori-browserpier` | Developer | `7436` (`+7438` WebRTC) | `amd64`, `arm64` | Persistent Chromium browser profiles your AI agents can borrow via CDP, REST, or MCP |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `yakitori-deepseek-harness` | AI | `8734` | `amd64`, `arm64` | DeepSeek's open-source agent harness in your browser with local workspace storage |
| [Doop](https://github.com/kgoedecke/doop) | `yakitori-doop` | Productivity | `4400` | `amd64` | Multiplayer real-time design canvas for humans and AI agents with built-in MCP |
| [It's a Plan](https://github.com/croffasia/itsaplan) | `yakitori-itsaplan` | Files | `8743` (HTTPS) | `amd64`, `arm64` | Self-hosted issue tracker, docs, boards, and workflows for teams and AI agents |
| [Octop](https://github.com/TencentCloud/Octop) | `yakitori-octop` | AI | `8105` | `amd64`, `arm64` | Multi-user, multi-agent AI assistant with web dashboard, IM channels, RAG, and cron |

## Notes

- **`manifestVersion: 2` / `2.0` apps** (`yakitori-browserpier`, `yakitori-doop`, `yakitori-itsaplan`) require **umbrelOS 2.0 or newer**.
- **Image pinning:** Application and infrastructure images are pinned to release tags and `@sha256:...` digests for reproducible installs and updates.
