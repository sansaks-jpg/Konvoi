# Networking

> **Build Policy:** NEVER run Gradle (./gradlew) on local laptop. Native Android and iOS builds must ALWAYS be executed in GitHub Actions.

Transport, discovery, and room lifecycle for Konvoi. Product requirements live
in [`SPEC.md`](SPEC.md). This document describes what the code actually does and
what is still unverified.

## Topology

```
        TCP room connection (NDJSON)          TCP room connection
  Guest A ────────────────────────┐   ┌──────────────────────── Guest B
                                  ▼   ▼
                            Host phone
                     RoomEngine + TCP listener
                     mDNS advertiser (_konvoi._tcp)

  Guest A ◀──────── WebRTC audio (P2P, Opus) ────────▶ Guest B
```

- The host is authoritative for membership, participant IDs, voice membership,
  timestamps, and location relaying.
- Signaling and location use the host's TCP star. Audio never travels over TCP.
- Voice is an audio mesh: each pair of voice participants gets one
  `RTCPeerConnection`. The lexicographically smaller participant ID offers; the
  other answers. There is no STUN or TURN (`iceServers: []`).
- Room capacity is 16 including the host; voice capacity is 16 concurrent.

## Addresses and ports

- The host binds a TCP listener to `0.0.0.0` on an OS-assigned port
  (`port: 0`). The bound port is shown on the host screen.
- Guests connect via Camera QR Code scan (1-tap join without typing PIN), mDNS discovery, or manual IP + port + 6-digit PIN entry.
- **Known limitation:** the app does not auto-detect the host's own LAN IPv4
  address. `react-native-zeroconf` exposes remote service addresses, not the
  local device address, and no local-IP native module is installed yet. The host
  screen tells the user to read the address from Wi-Fi settings and lists the
  common hotspot defaults (`192.168.43.1`, `172.20.10.1`). Adding a local-IP
  module is a follow-up; it must be verified against React Native 0.88 and the
  New Architecture before shipping.
- Never display loopback (`127.0.0.1`) as the host address.

## mDNS

- Service type: `_konvoi._tcp`.
- Instance name: `Konvoi-<roomId>`.
- TXT keys:
  - `room` — room ID
  - `name` — room name
  - `proto` — protocol version
- The **PIN is never advertised** and never included in invite links or QR
  codes. mDNS is a convenience; manual entry is the fallback.
- Advertising failure is non-fatal: the room keeps running and the host screen
  switches to “Mode manual”.
- Discovery runs only while the Join Room screen is open. `Muat ulang` stops the
  previous scan and starts a new one. A room whose TXT `proto` differs is shown
  with a “Versi beda” badge; the host will reject the join with
  `INCOMPATIBLE_PROTOCOL`.
- mDNS requires local-network permission on iOS and multicast/Wi-Fi state
  permissions on Android. See below.

## Wire format

- UTF-8 **NDJSON**: one JSON object per line, terminated by `\n`.
- Each connection has its own byte buffer. A TCP chunk is not a message.
- Maximum frame size is 64 KiB including the newline. Oversized frames produce
  an error, the buffer is dropped, and the host closes that connection.
- Malformed JSON is rejected per frame; the connection stays open and parsing
  resynchronizes at the next newline.
- Every message is validated on receipt. The host never rebroadcasts arbitrary
  JSON.

## Join flow

1. Guest connects over TCP with a timeout.
2. Guest sends `JOIN_REQUEST` with display name, PIN, and an optional room ID.
   Manual joins may send `roomId: ""`; the host accepts the PIN and the guest
   adopts the room ID from `JOIN_ACCEPTED`.
3. Host validates protocol version, room ID (when supplied), PIN, capacity, and
   rate limits, then assigns the participant ID.
4. Host replies `JOIN_ACCEPTED` with the room name, host ID, participant
   snapshot, voice roster, and voice capacity, or `JOIN_REJECTED` with a reason.
5. After acceptance, every client message carries `protocolVersion` and the
   adopted `roomId`. Messages for another room are ignored.
6. `ClientSession` starts a `PING` heartbeat automatically when the host
   accepts the join, every 10 s. The host drops a connection after 30 s of
   silence and broadcasts `PARTICIPANT_LEFT`. A guest that receives no valid
   host message for 30 s closes the socket and shows the disconnected state, so
   a dead host does not leave a zombie room on screen.

Rejection reasons: `WRONG_PIN`, `ROOM_FULL`, `ROOM_CLOSED`,
`INCOMPATIBLE_PROTOCOL`, `INVALID_REQUEST`, `RATE_LIMITED`.

## Messages

No chat types exist.

- `JOIN_REQUEST`, `JOIN_ACCEPTED`, `JOIN_REJECTED`
- `PARTICIPANT_JOINED`, `PARTICIPANT_LEFT`
- `ROOM_STATE`, `LEAVE_ROOM`, `ROOM_CLOSED`, `KICK_PARTICIPANT`
- `PING`, `PONG`, `ERROR`
- `VOICE_JOIN`, `VOICE_LEAVE`, `VOICE_SIGNAL`, `VOICE_MUTE_STATUS`,
  `VOICE_PARTICIPANT_STATE`
- `LOCATION_SHARING_STATUS`, `LOCATION_UPDATE`, `LOCATION_SHARING_STOP`

Rate limits: join attempts 5 per minute per connection; voice signals 60 per
10 s; location updates 6 per 10 s with a 3 s minimum interval and a 60 s maximum
fix age.

## Location relay

- Sharing is opt-in per participant and visible in the roster.
- The host validates membership, sharing state, coordinate ranges, accuracy,
  timestamp plausibility, and rate.
- The host broadcasts each accepted update back to the sender so both sides keep
  the same authoritative snapshot.
- Stopping sharing, leaving, being kicked, or closing the room clears that
  participant's coordinates immediately.
- Locations are in memory only: never logged, persisted, or put in mDNS.

## Permissions

iOS (`ios/Konvoi/Info.plist`):

- `NSLocalNetworkUsageDescription`
- `NSBonjourServices` = `_konvoi._tcp`
- `NSLocationWhenInUseUsageDescription` (for the planned location feature)
- `NSMicrophoneUsageDescription` (microphone starts only after **Mulai Suara**)

Android (`android/app/src/main/AndroidManifest.xml`):

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_WIFI_STATE`
- `CHANGE_WIFI_MULTICAST_STATE`
- `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` for opt-in voice

The zeroconf library also declares the Wi-Fi/multicast permissions in its own
manifest; the app manifest repeats them so the requirement is auditable.

## Troubleshooting

- **No rooms discovered:** confirm both phones are on the same network, the host
  room is open, iOS local-network permission is granted, and the router does not
  block multicast. Use manual IP/port/PIN.
- **Connection refused/timeout:** verify the IP and port, confirm the host app is
  in the foreground, and check that the network is not using client isolation.
  Some guest Wi-Fi networks block all peer-to-peer traffic; Konvoi will not route
  around that through the internet.
- **Guest drops after about 30 s:** the guest heartbeat must run. It starts
  automatically on `JOIN_ACCEPTED`; keep it that way when changing
  `ClientSession`. Also keep the app in the foreground with the screen on:
  Android Doze and screen-lock can suspend TCP sockets. Background hosting is
  out of scope for release 1.
- **Guest connects but voice fails:** check that both phones can reach each
  other directly. ICE failures on a LAN must be reported as a
  network/client-isolation problem, never worked around with STUN/TURN. See
  [`VOICE_AND_BLUETOOTH.md`](VOICE_AND_BLUETOOTH.md) for the audio path and
  verification checklist.

## Verification status

Unit tests cover framing, validation, the host engine, sessions, and offerer
selection. The TCP and mDNS adapters are exercised only on devices. At minimum,
two physical phones on a WAN-less network must verify:

- mDNS discovery and manual join;
- TCP reachability with the host in the foreground;
- client isolation behavior on the target router/hotspot;
- join rejection reasons and heartbeat timeout;
- that closing/kicking clears sockets and room state.

Record the devices, OS versions, and network used. Until then, treat the
transport as **unverified**.


## Web Tester & Simulator Tool

For developers with only one physical mobile phone, an offline Node.js web simulator is provided in web-tester/:

\sh
npm run test:web
\\r

Opens at http://localhost:3000. It implements the full NDJSON protocol, automatic 10-second PING/PONG heartbeats, WebRTC audio mesh negotiation, QR code generation, and simulated GPS location sharing.
