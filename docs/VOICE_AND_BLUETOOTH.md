# Voice and Bluetooth

> **Build Policy:** NEVER run Gradle (./gradlew) locally on laptop. Native Android APKs and iOS builds must ALWAYS be compiled via GitHub Actions.

Audio design, microphone lifecycle, and the Bluetooth realities for Konvoi.
Product requirements live in [`SPEC.md`](SPEC.md); transport and discovery live
in [`NETWORKING.md`](NETWORKING.md). This document describes what the code does
today and what is still unverified.

## Topology

Voice is an **audio mesh**, not a conference bridge:

```
  Host ◀──────── WebRTC audio ────────▶ Guest A
    ▲                                     ▲
    │                                     │
    └──────── WebRTC audio ────────▶ Guest B
                  Guest A ◀──────▶ Guest B
```

- Every voice participant has one `RTCPeerConnection` per other voice
  participant. With the default voice cap of 6, one phone holds at most 5 peer
  connections.
- Signaling (`offer`, `answer`, `ice-candidate`) travels through the host's TCP
  room as `VOICE_SIGNAL` messages. Audio never travels over TCP and never
  passes through the host unless the host is one of the two peers.
- The host relays signaling but does not observe, record, or mix media. The
  host UI can only show roster state, not whether a remote peer's audio is
  actually audible.

## Offer/answer rules

`src/voice/voiceSignaling.ts` makes negotiation deterministic:

- For each pair, the participant with the **lexicographically smaller
  participant ID** creates the initial offer. The other participant answers.
- The answering side is the "polite" peer. If both sides create an offer at
  the same time (glare), the polite peer rolls back its local offer and accepts
  the remote one; the impolite peer ignores the colliding offer.
- ICE candidates that arrive before the remote description are buffered and
  applied afterward.
- `VOICE_SIGNAL` is rate-limited by the host (60 messages per 10 s per
  connection). SDP is bounded to 24 KiB and candidates to 1 KiB by the
  protocol validators.

No participant ID is chosen by the client, so the offerer rule cannot be
manipulated by a guest.

## No STUN, no TURN, no internet

The peer connection is created with:

```ts
new RTCPeerConnection({ iceServers: [] });
```

- There is no STUN server, no TURN relay, and no cloud signaling. Host
  candidates on the local network are the only ICE candidates.
- Both phones must be on the same Wi-Fi or phone hotspot and must be able to
  reach each other directly. Routers with **client isolation** block this.
- If ICE fails, the app reports a network/client-isolation problem. It must
  **not** add a public STUN/TURN server to make the call connect. That would
  violate the offline requirement and leak metadata.
- A phone hotspot usually allows peers to reach the host, but some Android
  hotspot configurations isolate clients. This is a device/network variable,
  not something the app can fix without a relay.

## Microphone lifecycle

The microphone is strictly opt-in:

1. The user opens the room screen and presses **Mulai Suara**.
2. `VoiceManager.start()` calls `mediaDevices.getUserMedia({ audio: true,
video: false })`. The OS may show its microphone permission prompt on the
   first use.
3. Only after a track is obtained does the app send `VOICE_JOIN`. The host adds
   the participant to the voice roster and broadcasts the change.
4. Peers connect according to the roster diff.

The microphone stops when any of these happen:

- the user presses **Keluar dari Suara**;
- the user leaves the room (guest) or closes the room (host);
- the host kicks the participant;
- the host closes the room;
- the app moves to the background (`AppState` change);
- the audio track ends (for example, permission revoked in system settings).

Mute is implemented with `track.enabled = false` and a `VOICE_MUTE_STATUS`
broadcast. The peer connection stays open; only the outgoing audio is silenced.
The UI labels the local state as **Bisu**, and remote participants see the same
mute badge from the roster. There is no audio recording, buffering, or
persistence.

If microphone permission is denied, `getUserMedia` rejects and the app shows an
actionable Indonesian error. It does not retry silently and does not show a
fake "active" state.

## Bluetooth headsets and intercoms

Konvoi does **not** implement a Bluetooth stack, pairing UI, or a proprietary
intercom protocol. It relies on the operating system's audio route:

- Pair the helmet intercom or headset in the phone's system Bluetooth settings
  **before** starting voice.
- The OS routes call audio through **HFP/HSP** (hands-free/headset profile)
  when the device supports a microphone.
- Output-only **A2DP** devices (many speakers and some audio-only helmet units)
  cannot provide a microphone. The app cannot turn an A2DP sink into a mic and
  must not pretend it did.
- Some intercoms expose separate rider/passenger channels or require a brand
  app. Konvoi cannot control those features. Support is whatever the OS does
  with a standard HFP/HSP route.
- Route changes (headset connects/disconnects) are handled by the OS. The app
  does not display a guaranteed "Bluetooth active" badge, because it cannot
  reliably observe the active route through `react-native-webrtc`.

There is no universal intercom guarantee. Record the exact headset/intercom
model and OS version when testing; mark untested models as unsupported.

## Permissions

iOS (`ios/Konvoi/Info.plist`):

- `NSMicrophoneUsageDescription` explains that the mic starts only on **Mulai
  Suara** and stops on leave/background.

Android (`android/app/src/main/AndroidManifest.xml`):

- `RECORD_AUDIO`
- `MODIFY_AUDIO_SETTINGS`

The runtime permission request is triggered by `getUserMedia` on first use.
There is no background audio service and no foreground service for voice.

## Implementation map

| File                                 | Responsibility                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/voice/voiceSignaling.ts`        | Deterministic offerer rule and roster diffing                                               |
| `src/voice/voiceManager.ts`          | The only file importing `react-native-webrtc`; mic, peers, negotiation, mute, teardown      |
| `src/protocol/messageTypes.ts`       | `VOICE_JOIN`, `VOICE_LEAVE`, `VOICE_SIGNAL`, `VOICE_MUTE_STATUS`, `VOICE_PARTICIPANT_STATE` |
| `src/features/room/roomEngine.ts`    | Voice roster, capacity, signal relay, mute state                                            |
| `src/features/room/hostSession.ts`   | Surfaces host-targeted `VOICE_SIGNAL` to the app                                            |
| `src/networking/clientSession.ts`    | Sends guest voice messages, surfaces incoming signals                                       |
| `src/state/useRoomApp.ts`            | Starts/stops voice, syncs peers with the roster, handles background                         |
| `src/screens/VoiceRoomScreen.tsx`    | Start/mute/leave controls and honest status                                                 |
| `src/components/ParticipantTile.tsx` | Roster badges (mic active, muted, connecting, failed)                                       |

## Failure behavior

- **Mic permission denied:** error banner; voice stays inactive.
- **No audio track:** error banner; stream is released.
- **Peer connection `failed`:** per-peer error banner suggests checking client
  isolation, then retrying. The peer is not silently reconnected with STUN.
- **Peer `disconnected`:** shown as **Terputus** in the roster. WebRTC may
  recover on its own; there is no forced ICE restart in release 1.
- **Track ended:** voice stops, `VOICE_LEAVE` is sent, and the user is told to
  check microphone permission.
- **App backgrounded:** voice stops and leaves the voice roster. There is no
  background audio.

## Verification status

Unit tests cover only the deterministic planning rules
(`src/voice/__tests__/voiceSignaling.test.ts`). `VoiceManager` is not unit
tested against the native module; Jest uses a stub whose `getUserMedia`
rejects. CI proves compilation, not audio.

`react-native-webrtc@155.0.1` is a legacy `NativeModules` package. Its
compatibility with React Native 0.88 and the New Architecture must be proven by
the GitHub Actions Android/iOS builds before this feature can be called
working. If the native build fails, document the blocker and alternatives; do
not disable the workflow to get a green check.

Minimum two-phone, WAN-less test matrix:

- [ ] Android ↔ Android on a phone hotspot.
- [ ] Android ↔ iOS on the same Wi-Fi.
- [ ] iOS ↔ iOS on the same Wi-Fi.
- [ ] Three participants, all pairwise audio.
- [ ] Mute is reflected on the other phones; unmute restores audio.
- [ ] Leave voice, leave room, kick, and host close all stop the mic.
- [ ] Backgrounding the app stops the mic and removes the voice badge.
- [ ] Microphone permission denial and later grant.
- [ ] Bluetooth HFP/HSP headset in both directions; A2DP-only device shows no
      usable mic.
- [ ] Client-isolation network produces a clear failure, not a silent hang.
- [ ] No audio is logged or written to storage.

Record devices, OS versions, headset models, and network hardware with the
results. Until then, voice is **implemented but unverified**.
