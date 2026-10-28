# AGENTS.md

Konvoi is a **voice-first** React Native app: the host phone runs a room server on the local Wi-Fi/hotspot, participants talk over a WebRTC audio mesh, and consenting participants share live positions on an offline map. **No text chat**, no internet at runtime.

**Read `docs/SPEC.md` before implementing.** It is the authoritative product/technical spec (screens, protocol, acceptance criteria) and is not auto-loaded. This file covers repo state, commands, and traps.

> [!CAUTION]
> ### ATURAN KRUSIAL: JANGAN BUILD GRADLE DI LAPTOP (SELALU DI GITHUB ACTIONS)
> **JANGAN PERNAH MENJALANKAN BUILD GRADLE / NATIVE DI MESIN LOKAL / LAPTOP INI.**
> Dilarang mengeksekusi `./gradlew`, `gradlew.bat`, `assembleDebug`, atau kompilator native lokal. Mesin lokal ini **HANYA** diperuntukkan untuk:
> 1. `npm run lint` (ESLint)
> 2. `npx tsc --noEmit` (TypeScript typecheck)
> 3. `npm test` (Jest unit tests)
> 4. `npm run test:web` (Web tester simulator untuk testing lokal)
>
> **SEMUA NATIVE BUILD (Android APK & iOS Simulator) HARUS SELALU DIJALANKAN DI GITHUB ACTIONS (GH WORKFLOWS).**

> [!IMPORTANT]
> ### KONSISTENSI DOKUMENTASI VS KODE EKSISTING
> When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code.

---

## Repo state (Updated 2026-10-28)

- React Native **0.88.1** + TypeScript 6, package `Konvoi`, Android/iOS id `com.konvoi`, mDNS `_konvoi._tcp`.
- Git repository synced with upstream `origin` (`https://github.com/neosaragih/Konvoi.git`) and `fork` (`https://github.com/sansaks-jpg/Konvoi.git`).
- **PR #1 Merged into main:** PR #1 (`Google Maps style OSM, GPS distance, camera QR scan, auto-reconnect, and host voice fix`) has been officially merged into upstream `neosaragih/Konvoi`.
- **Implemented & Proven:**
  - NDJSON framing (UTF-8, per-connection buffer, max 64 KiB).
  - Typed protocol + validators (6-digit PIN mandatory, 16 riders capacity).
  - Host room engine (state machine, membership, voice roster, signaling relay, location sharing).
  - WebRTC voice mesh (deterministic smaller-ID-offers planning, speaker routing, audio track activation).
  - Native Android GPS location module + CartoDB Voyager OpenStreetMap tiles with Google Maps-style heading & pulse dots.
  - Real-time Haversine inter-rider distance calculation with proximity badges (*Dekat*, *Sedang*, *Tertinggal*).
  - Camera QR scanner 1-tap join (via Google Play Services Barcode scanner).
  - Android Foreground Service (`KonvoiForegroundService`) keep-alive with ongoing notification, WakeLock, and WifiLock.
  - Automatic background reconnection on Wi-Fi loss.
  - Adopted `react-native-reusables` (shadcn dark palette Zinc/Slate) design system, 100% emoji-free.
  - Web Tester tool (`web-tester/server.js` / `npm run test:web`) for single-device voice & GPS simulation.
- Native builds run purely in **GitHub Actions** (`ci.yml`, `android.yml`, `ios.yml`).

## Commands

- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run test:web` (Menjalankan Web Tester & Simulator di `http://localhost:3000`)
- one suite: `npm test -- src/features/room/__tests__/roomEngine.test.ts`
- one case: `npm test -- src/features/room/__tests__/roomEngine.test.ts -t "relays a signal"`
- Order before pushing: `lint` -> `tsc --noEmit` -> `jest`.

## Build pipeline (GitHub Actions)

- `.github/workflows/ci.yml` — `npm ci`, lint, typecheck, Jest on Ubuntu.
- `.github/workflows/android.yml` — Ubuntu + JDK 17 + Android SDK, `./gradlew :app:assembleDebug :app:assembleRelease`, uploads `konvoi-debug-apk` (needs Metro) and `konvoi-dev-apk` (bundled JS, debug-signed). The dev APK is not production-signed.
- `.github/workflows/ios.yml` — macOS + CocoaPods, unsigned simulator build, uploads `konvoi-ios-simulator`.
- All native APK and iOS binaries are built by GH Workflows, never locally.

## Architecture

- **Voice-first, no chat.** There is no chat message type, screen, composer, or history. Don't reintroduce one.
- **Host = server.** `src/features/room/roomEngine.ts` is a transport-agnostic state machine. It emits `send` / `disconnect` / `closed` events; the TCP adapter must apply them and skip `HOST_CONNECTION_ID` when writing sockets (that ID is the in-process host UI).
- **Wire format:** UTF-8 NDJSON in `src/networking/ndjsonFramer.ts`. Byte-level, per-connection buffer, max frame size, resync after oversized lines. A TCP chunk is not a message.
- **Protocol:** `src/protocol/{messageTypes,validators,protocolVersion}.ts`. Host assigns participant IDs and timestamps; clients never supply identity. Validate on both ends.
- **Voice mesh:** `src/voice/voiceSignaling.ts`. For each pair, the lexicographically smaller participant ID offers; the other answers. Signaling goes through the host's TCP room; media is P2P WebRTC with `iceServers: []`.
- **Heartbeat:** `ClientSession` starts `PING` automatically on `JOIN_ACCEPTED` (every 10 s). The host drops silent guests after 30 s; the guest closes after 30 s without host messages.
- **Tests:** `src/**/__tests__/*.test.ts`; protocol/engine tests must not import native modules.

## Traps

- **No local Gradle builds:** Never run `./gradlew` locally. Native builds belong in GitHub Actions.
- **No runtime internet.** No cloud/hosted signaling, analytics, remote fonts/images, or CDN assets.
- **Don't add STUN/TURN** to make voice connect. If ICE fails, show a LAN/client-isolation error.
- **No E2E/encryption claims.** The PIN gates joining; signaling and location are plaintext on the LAN.
- **Mic is opt-in.** Starts only on explicit Start Voice, visibly indicated, and stops on Leave Voice/disconnect.
- **Bluetooth = OS-managed HFP/HSP route.** Pairing happens in system settings.
- **Offline map must never fall back online.** Missing coverage needs an explicit UI state.
- **Never log or persist** PINs, coordinates, or audio. Locations are in-memory for the room only and cleared on stop/leave/kick/close.
