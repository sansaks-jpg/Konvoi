# Konvoi — Offline LAN Voice + Live Map

> Authoritative requirements. `AGENTS.md` covers repo state, commands, and verification limits. Last reviewed: 2026-10-28 (greenfield).

## 0. Product

Konvoi is a **voice-first** group communication app for people on the same local network — a convoy, riding group, hike, or event with no cellular coverage.

- **Primary feature:** real-time group voice, comparable to a Discord voice channel or a WhatsApp group call, hosted by one participant's phone.
- **Secondary feature:** live location of consenting participants on an offline map.
- **Explicitly out of scope:** text chat, video, accounts, cloud sync, permanent history, background hosting/audio, and any runtime internet dependency.

The target user pairs a helmet intercom or headset in the phone's Bluetooth settings, creates or joins a room, presses **Mulai Suara**, and talks while the Live Map shows the group.

## 1. Non-negotiable requirements

1. **No internet at runtime.** No cloud backend, hosted signaling, Firebase/Supabase, external API, analytics, CDN assets, remote fonts, or required login.
2. Works on a router LAN or phone hotspot with **WAN disconnected**, as long as devices can reach each other.
3. **The host phone is the room server.** No laptop, desktop, or separate server for normal use.
4. **Star topology:** clients connect to the host over TCP; the host validates and relays signaling and location. Voice media is peer-to-peer WebRTC, not relayed by the host.
5. Typed, versioned message contracts; networking isolated from UI.
6. **No end-to-end encryption claim.** The room PIN gates joining but does not encrypt signaling or location. Never call the app "secure", "private", or "encrypted". Do not log message contents, PINs, or coordinates.
7. Same-Wi-Fi reachability is not guaranteed: routers/hotspots may enable **client isolation**. Detect failures and explain how to check it; never route around it via the internet.
8. Real Android and iOS native builds; bare React Native (no Expo Go) because TCP, mDNS, WebRTC, Bluetooth routing, and MapLibre need native code.
9. Verify current library compatibility (React Native version + New Architecture) before adding each native module; pin versions and document setup.
10. Microphone use is **opt-in, visible, muteable**, and stopped on leave/kick/room close/permission revocation. Never open the mic because the app opened or the user joined a room.
11. Live location is **opt-in, foreground-only, room-scoped, throttled, visible, and stoppable**. Never persist coordinates or location history.
12. Offline map rendering must use a **locally stored, licensed MapLibre-compatible map pack**. A renderer alone has no map data. Never fetch styles, tiles, glyphs, sprites, geocoding, or routing at runtime; never silently fall back online.
13. Do not bulk-download `tile.openstreetmap.org`. Use a licensed offline provider or self-hosted/OSM-derived data with attribution.
14. Voice uses `iceServers: []`. No STUN, TURN, or hosted signaling. If ICE fails, show a LAN/client-isolation error.
15. Bluetooth support uses the **OS-managed HFP/HSP route**; pairing happens in system settings. No vendor intercom SDKs. Output-only A2DP devices cannot provide a microphone — say so.
16. Foreground-only for release 1: no background audio, background location, or reliable background hosting promises.

## 2. Topology and lifecycle

### Host

1. **Buat Ruangan** with display name and room name.
2. Generate a random room ID and a 6-digit PIN from a cryptographically secure source.
3. Start a TCP server on `0.0.0.0` (configurable port) and find the usable LAN IPv4 address; never display loopback.
4. Advertise `_konvoi._tcp` over mDNS with room ID, room name, protocol version, and port only. **Never put the PIN in TXT records.**
5. Show room name, PIN, host IP/port, participant count, and "Host aktif — biarkan aplikasi terbuka".
6. Accept joins, enforce capacity, relay validated signaling/location, track voice membership.
7. On close: notify clients, stop advertising, close sockets, stop voice, clear room state.

### Guest

1. **Gabung Ruangan** via instant Camera QR Code scan (1-tap join), mDNS list, or manual IP + port + 6-digit PIN.
2. Connect with a timeout; send a versioned join request.
3. Show explicit rejection reasons: wrong PIN, room full, closed, incompatible protocol, timeout.
4. On accept, receive the participant/voice snapshot.
5. **Voice starts only after an explicit tap.** Leaving voice does not leave the room; leaving the room tears down all peers.

## 3. Voice

- **Audio-only WebRTC mesh.** Each pair of voice participants has one `RTCPeerConnection` with Opus audio.
- Signaling (`offer`, `answer`, ICE candidate) travels through the host's TCP room connection. Audio never travels over TCP.
- **Capacity:** room 16 including host; voice 16 concurrent mesh participants.
- **Negotiation:** for each pair, the participant with the lexicographically smaller ID creates the initial offer and the other answers. Renegotiation uses the WebRTC perfect-negotiation pattern to survive glare. Never have both sides offer at once.
- **Mute/unmute** disables the local audio track and broadcasts `VOICE_MUTE_STATUS`; the UI shows every participant's mute state.
- **Voice state** (`VOICE_PARTICIPANT_STATE`) carries voice membership and mute state — never audio data. Per-peer connection quality is local to each device because the host cannot observe the P2P media path.
- **Audio route:** prefer a connected Bluetooth HFP/HSP device, then wired headset, then speaker. Show the active route and whether a microphone route exists. On Bluetooth disconnect, switch to a clearly indicated fallback or pause voice; never pretend the intercom is still active.
- **Audio session:** two-way communication category/mode, echo cancellation, noise suppression, automatic gain control. Handle interruptions (calls, assistants, permission changes) and route changes; restore cleanly on exit.
- **Teardown:** stop tracks, close peer connections, release the audio session, and stop the mic on Leave Voice, room leave, kick, room close, or permission revocation.
- **Intercom Resilience:** On Android, KonvoiForegroundService runs an ongoing foreground service with status bar notification, WakeLock, and WifiLock so audio, socket, and GPS stay alive when minimized or during screen lock.
- Keep the voice UI hands-free-oriented: large mute control, visible route/mic status, minimal need to look at the screen while moving.

## 4. Live map and location

- Sharing is per participant, **explicitly enabled**, and visibly indicated at all times.
- Foreground location only. No background permission.
- Updates travel over the host's TCP room connection; the host validates and relays.
- Host validation: finite latitude/longitude in range, sane accuracy, plausible timestamp, room membership, sharing enabled, update rate.
- Throttle to at most one update per 3 s per participant and prefer sending only after 5–10 m of movement; tune on devices.
- Mark a position **stale after 15 s** without a fresh update. Never imply a stale marker is live.
- Clear a participant's coordinates immediately on stop-sharing, leave, kick, or room close. No location history.
- Never persist, log, or include coordinates in mDNS, invites, or QR codes.
- The map renders only from the bundled offline pack. Outside coverage, show an explicit unavailable-area message — no blank grid, no online tiles.
- Show accuracy radius when useful, last-updated time, and per-participant sharing status.
- Map attribution and licence are visible in the app and documented.

## 5. Protocol

UTF-8 **NDJSON**: one JSON object per line terminated by `\n`. Each connection has its own buffer and a maximum frame size. Reject malformed/oversized frames without crashing; resynchronize at the next newline.

Envelope fields where applicable:

- `type`, `protocolVersion`, `roomId`
- `requestId` / `clientMessageId` for request matching and retry dedupe
- `senderId` assigned by the host — never trust a client-supplied identity
- `timestamp` generated by the host for accepted events

Message types (no chat types):

- `JOIN_REQUEST`, `JOIN_ACCEPTED`, `JOIN_REJECTED`
- `PARTICIPANT_JOINED`, `PARTICIPANT_LEFT`
- `ROOM_STATE`, `LEAVE_ROOM`, `ROOM_CLOSED`, `KICK_PARTICIPANT`
- `PING`, `PONG`, `ERROR`
- `VOICE_JOIN`, `VOICE_LEAVE`, `VOICE_SIGNAL`, `VOICE_MUTE_STATUS`, `VOICE_PARTICIPANT_STATE`
- `LOCATION_SHARING_STATUS`, `LOCATION_UPDATE`, `LOCATION_SHARING_STOP`

Behavior:

- Host is authoritative for participant IDs, join approval, voice membership, event IDs, and timestamps.
- Validate every field; never rebroadcast arbitrary JSON.
- Rate-limit joins, chat-free signaling, and location updates. Enforce strict signaling payload size and per-sender rate.
- Relay `VOICE_SIGNAL` only when sender and destination are current room members **and** both are in the voice session. Never cross rooms. Never relay audio bytes.
- Heartbeat with timeout; clean up stale connections and their voice/location state.
- Deduplicate retries by `clientMessageId`; host echo is the single source of truth.
- `PING`/`PONG` for liveness; drop connections that miss the timeout.

## 6. Room access

- Random room ID + random PIN per room; a room name never authorizes joining.
- Treat the PIN as a convenience, not strong security. Rate-limit join attempts; let the host kick.
- Keep PINs out of mDNS and logs.
- Bind only what LAN hosting needs; test reachable interfaces on both platforms.
- Request only permissions the enabled features need, at the moment they are used.
- Document the lack of whole-app E2E encryption. WebRTC media is encrypted in transit between peers; signaling and location over TCP are not.
- Follow-up (not release 1): TLS with certificate/fingerprint verification and/or E2E encryption for signaling/location.

## 7. Screens (Indonesian UI)

1. **Beranda** — app name, Buat Ruangan, Gabung Ruangan, and "Bekerja di Wi-Fi yang sama; internet tidak diperlukan".
2. **Buat Ruangan** — display name, room name, validation, startup/loading/error states.
3. **Host Ruangan** — room name, PIN, host IP/port, participants, voice roster, host kick/close controls, keep-open notice.
4. **Gabung Ruangan** — discovered rooms, refresh, manual IP/port/PIN, connection progress and errors.
5. **Ruang Suara** (primary) — participant tiles with mute/connection state, Start Voice, Mute/Unmute, Leave Voice, audio-route indicator, Leave Room, link to map.
6. **Peta Langsung** — offline map, own marker, sharing participants, accuracy, last-updated, stale styling, per-user sharing status, one-tap stop.
7. **Pengaturan/Tentang** — version, platforms, LAN/offline limits, map coverage/version, Bluetooth compatibility notes, attribution/licences.

No chat screen, composer, message list, or chat history.

### UX rules

- Distinguish connecting/connected/disconnected visually and in text.
- Actionable errors, e.g. "Tidak bisa terhubung. Pastikan kedua perangkat di Wi-Fi yang sama dan client isolation di router tidak aktif."
- Disable duplicate Create/Join taps while connecting.
- Handle safe areas, small screens, long names, and permission denial without breaking the room.
- Voice status must show: mic live/muted, local voice connection state, and selected audio route.
- Location denial must not break voice or room membership.
- Never fake networking, discovery, presence, voice, routes, or map data.

## 8. Platform setup

Verify current docs before implementing.

- **iOS:** `NSLocalNetworkUsageDescription`, `NSBonjourServices` for `_konvoi._tcp`, `NSMicrophoneUsageDescription`, `NSLocationWhenInUseUsageDescription`. Configure `AVAudioSession` for two-way voice with Bluetooth HFP; observe route-change and interruption notifications. No background modes in release 1.
- **Android:** `INTERNET`, `ACCESS_NETWORK_STATE`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`, `BLUETOOTH_CONNECT` on API 31+ with legacy Bluetooth permissions SDK-limited. Add Wi-Fi/network permissions only if the chosen libraries need them. No background location.
- Use current Android communication-device routing (`AudioManager.setCommunicationDevice`) where supported; no deprecated SCO routing.
- Keep style JSON, glyphs, sprites, and all map assets local; audit the style dependency tree for remote URLs.
- All app assets bundled; no remote fonts, images, or runtime config.

## 9. Project layout

```text
src/
  protocol/        messageTypes, validators, protocolVersion
  networking/      ndjsonFramer, tcpServer, tcpClient, roomDiscovery, connectionManager
  voice/           voiceSessionManager, webrtcPeerManager, voiceSignaling, audioRouteManager
  location/        locationService, locationSharingManager
  maps/            offlineMap, mapCoverage, mapAttribution
  features/room/   roomEngine (host state machine)
  screens/         Home, CreateRoom, JoinRoom, HostRoom, VoiceRoom, LiveMap, Settings
  components/      VoiceTile, ConnectionStatus, ParticipantList, RouteBadge
  state/           roomStore, voiceStore
  utils/           localIp, secureRandom, logger
  assets/maps/     bundled offline pack
  theme/
  __tests__/
```

Protocol, framing, room engine, and signaling orchestration must be unit-testable without native modules.

## 10. Phases

1. **Networking spike:** host TCP server + client on two physical devices, no WAN; IP discovery, reachability, clean close. Record in `docs/NETWORKING.md`.
2. **Offline map + GPS spike:** load a pre-generated MapLibre offline DB (`OfflineManager.mergeOfflineRegions`) or bundled MBTiles; render in airplane mode on both platforms; verify GPS fix without internet. Record in `docs/MAPS_OFFLINE.md`.
3. **Voice spike:** `react-native-webrtc`, `iceServers: []`, signaling over TCP, 2–6 devices with WAN off; verify LAN-only ICE; pair a helmet intercom (HFP) and a reference headset; test disconnect/reconnect. Record in `docs/VOICE_AND_BLUETOOTH.md`.
4. **Protocol + room engine:** NDJSON framing, typed messages, host state machine for membership/voice/location, tests for split/merged frames.
5. **Discovery + fallback:** mDNS advertise/browse, manual IP/port/PIN, permission denial.
6. **UI:** all screens, real state, host controls.
7. **Map:** offline renderer, sharing lifecycle, stale handling, attribution.
8. **Voice integration:** peer mesh, mute, route status, teardown, map-open audio.
9. **Hardening:** malformed/oversized input, rate limits, reconnects, stale sockets, secret redaction, offline audit.
10. **Device verification + docs:** physical Android/iOS, tests, limitations.

## 11. Acceptance criteria

- Host creates a room with WAN disabled; two or more physical devices join over LAN/hotspot.
- Group voice works with 2, 4, and the documented maximum (target 6) with **no STUN/TURN** and no cloud signaling; media stays on the LAN.
- Mic is off until Start Voice; mute/unmute and participant mute state are correct; leave/kick/close/permission revocation tears audio down.
- A paired HFP/HSP helmet intercom provides mic and speaker; route status is truthful; A2DP-only devices get a clear limitation message.
- Voice keeps working with the Live Map open; map markers, sharing status, and voice state keep updating.
- Location sharing is opt-in, foreground-only, throttled, stale after 15 s, and removed on stop/leave/kick/close; no coordinates in storage or logs.
- Offline map renders documented coverage with WAN off; outside coverage shows an explicit message; no remote map requests.
- Wrong PIN, full room, closed room, timeout, malformed/oversized frames, client isolation, and lost connections produce controlled errors.
- mDNS discovery works where supported; manual IP/port/PIN always works.
- No runtime request to any public internet endpoint.
- Typecheck, lint, protocol/room tests, and available platform builds pass.
- `README.md`, `docs/NETWORKING.md`, `docs/MAPS_OFFLINE.md`, `docs/VOICE_AND_BLUETOOTH.md` describe the real architecture, voice cap, Bluetooth limits, background status, and lack of E2E encryption.

## 12. Test scenarios

1. Three devices on a router with WAN disconnected; host + two guests.
2. Host on a phone hotspot with two clients.
3. mDNS discovery success; discovery blocked with manual fallback.
4. Wrong PIN, room full, host closes room, guest leaves, host backgrounded/terminated.
5. Wi-Fi drop and reconnect during a voice session.
6. Malformed JSON, oversized frame, invalid type, signaling flood.
7. TCP split across `data` events; several lines in one event.
8. iOS local-network permission denied then granted; Android permission behavior.
9. Runtime traffic audit: no public internet endpoints.
10. Voice with 2, 4, 6 participants, WAN off, `iceServers: []`; verify ICE candidates and media path.
11. Pair/disconnect a helmet intercom mid-call; verify route, fallback, mute, recovery.
12. Output-only A2DP device: app explains no mic route.
13. Mic permission revoked mid-call; audio stops and UI updates.
14. Live Map open during voice; markers, sharing status, and voice state update together.
15. Location permission denied/revoked, sharing off, leave/kick/close; GPS watch stops and markers disappear.
16. Pan inside/outside offline coverage; no online tile requests.
17. Logs/storage audit: no PINs, coordinates, or audio.
18. Client isolation: clear LAN error, no internet fallback.

## 13. References

Verify current docs before implementation; these are not runtime dependencies.

- React Native networking: https://reactnative.dev/docs/network
- `react-native-tcp-socket`: https://github.com/Rapsssito/react-native-tcp-socket
- `react-native-webrtc`: https://github.com/react-native-webrtc/react-native-webrtc
- `react-native-incall-manager`: https://github.com/react-native-webrtc/react-native-incall-manager
- Android `AudioManager.setCommunicationDevice`: https://developer.android.com/reference/android/media/AudioManager#setCommunicationDevice(android.media.AudioDeviceInfo)
- Apple `AVAudioSession` Bluetooth options: https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetooth
- `react-native-zeroconf`: https://github.com/balthazar/react-native-zeroconf
- MapLibre React Native: https://maplibre.org/maplibre-react-native/docs/setup/getting-started/
- MapLibre OfflineManager: https://maplibre.org/maplibre-react-native/docs/modules/offline-manager/
- OSM tile policy: https://operations.osmfoundation.org/policies/tiles/
