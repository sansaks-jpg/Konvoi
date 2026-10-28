# Konvoi

Voice-first room app for convoys, riding groups, and events on the same local
network. One phone hosts the room, everyone else joins over Wi-Fi or a phone
hotspot. Voice is peer-to-peer WebRTC; the host relays only signaling and
location. There is **no text chat** and **no internet dependency**.

Indonesian UI. Android and iOS.

## Current status

| Area                                                       | State                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Protocol (NDJSON v1), validators, host room engine         | Implemented, unit-tested (16 capacity, 6-digit PIN)       |
| TCP host server + guest client (`react-native-tcp-socket`) | Implemented, verified with phone & web tester             |
| mDNS discovery + advertising (`react-native-zeroconf`)     | Implemented                                               |
| App screens, navigation, room lifecycle                    | Implemented, `react-native-reusables` Zinc theme (no emojis) |
| WebRTC audio mesh (`react-native-webrtc`)                  | Implemented & verified with host audio track routing      |
| GPS + live location                                        | Implemented (Native GPS + CartoDB OSM tiles)              |
| Inter-rider Distance Calculation                           | Implemented (Haversine real-time proximity)               |
| Camera QR Scanner                                          | Implemented (Google Play Services barcode scanning)       |
| Background Intercom Keep-Alive                             | Implemented (Android Foreground Service + WakeLock)       |
| Web Tester & Simulator Tool                                | Implemented (`npm run test:web`)                          |
| Native builds                                              | GitHub Actions green: Checks, Android APKs, iOS simulator |

## Requirements

- Devices connected to the same Wi-Fi network or phone hotspot.
- Android or iOS build of Konvoi on each device.
- Joining methods:
  - **Instant 1-Tap QR Scan:** Scan host's on-screen QR code with camera (no typing needed).
  - **Wi-Fi Discovery:** Select discovered room from local network list.
  - **Manual Entry:** Enter host IP, port, and 6-digit PIN.

## Build Policy (GitHub Actions Only)

> **IMPORTANT:** Do NOT run Gradle (`./gradlew`) builds on local development laptops. All native compilations (Android APKs and iOS simulator builds) are strictly executed via **GitHub Actions** workflows.

Native toolchains are not needed locally; builds run automatically on GitHub Actions:

- `.github/workflows/android.yml` — builds `assembleDebug` and `assembleRelease` on Ubuntu + JDK 17 + Android SDK. Uploads artifacts:
  - `konvoi-dev-apk`: standalone development build with JS bundle included.
  - `konvoi-debug-apk`: debug build.
- `.github/workflows/ios.yml` — unsigned simulator build, uploads `konvoi-ios-simulator`.
- `.github/workflows/ci.yml` — lint, typecheck, Jest.

Local machine checks (Node 24 / npm 11):

```sh
npm ci
npm run lint
npx tsc --noEmit
npm test
```

### Web Tester & Simulator (Testing with 1 Phone)

If you only have one physical phone, you can run the built-in offline Web Tester on your laptop to simulate the second peer (voice intercom + live GPS coordinates):

```sh
npm run test:web
```

Open `http://localhost:3000` in your laptop browser to connect to your phone or host a room for your phone to scan.

## Repository layout

```
App.tsx                         screen switch + Android back handling
src/protocol/                   message types, validators, NDJSON serialization
src/networking/                 framer, TCP adapter, sessions, mDNS discovery
src/features/room/              host engine, guest reducer, room sessions
src/voice/                      mesh signaling, offer/answer rules, WebRTC
src/scanner/                    camera QR code parser and scanner bridge
src/theme/                      tokens, Zinc/Slate dark palette
src/screens/                    Home, CreateRoom, HostRoom, JoinRoom, LiveMap, Settings
web-tester/                     standalone web simulator tool for single-device testing
android/                        native Android module (GPS, Foreground Service, QR scanner)
ios/                            native iOS project
```
