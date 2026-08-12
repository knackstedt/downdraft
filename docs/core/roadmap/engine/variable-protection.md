# Variable Protection Plan

A multi-layer anti-cheat system that leverages the engine's sim-in-worker architecture to protect game state from memory manipulation tools like Cheat Engine, with quantified performance costs and mathematical edge cases for each layer.

---

## Architecture Foundation

The sim runs authoritatively inside a Web Worker (`sim-worker-web.ts`). Internal `SimEntity[]` / `SimPlayer[]` arrays are the source of truth. Each tick, `writeToBuffer()` mirrors state to SharedArrayBuffers. The renderer reads SABs zero-copy but cannot mutate sim state directly — only via the input SAB and RPC commands.

**Buffer sizes (attack surface):**

| Buffer | Size | Direction | Tamper Impact |
|--------|------|-----------|---------------|
| Sim SAB | ~1.05 MB (256B header + 8192×128B entities + 8×256B players) | sim→renderer | Self-healing: overwritten next tick (16.67ms) |
| Input SAB | 576 B (64B header + 4×128B players) | renderer→sim | **Primary attack surface** — sim trusts this data |
| Water SAB | ~1.50 MB (64B + 256²×(4+12+8)B) | sim→renderer | Visual only — no gameplay impact |
| Boat SAB | ~49 KB (64B + 32×1544B) | sim→renderer | Visual only — cell layout for rendering |
| **Total** | ~2.65 MB | | |

**Key insight:** SAB tampering is self-healing. The sim overwrites all sim/water/boat SAB data every tick from internal arrays. A Cheat Engine user modifying the sim SAB sees their changes last exactly one frame before being erased. The real attack surfaces are: (1) the input SAB, (2) the JS heap objects that hold authoritative state, and (3) the RPC command channel.

---

## Protection Layers

### Layer 1: Input SAB Validation (sim worker, pre-tick)

**What it protects against:** aimbot (snap-to-target look angles), teleport (impossible movement requests), input automation (macro/bot detection).

**Mechanism:** Before `simulation.tick()`, validate the input SAB in `sim-worker-web.ts`:

```
For each player slot (max 4):
  1. Look heading rate check: |heading_new - heading_prev| / dt ≤ MAX_ANGULAR_VEL
  2. Look pitch clamp: -π/2 ≤ pitch ≤ π/2
  3. Key state transition check: no impossible simultaneous keys
     (e.g., W+S both held for >N ticks → flag as suspicious)
  4. Mouse delta rate check: |dx|, |dy| ≤ MAX_MOUSE_DELTA_PER_TICK
  5. Gamepad axis range: -1.0 ≤ axis ≤ 1.0
  6. Builder cell type / rotation: must be valid enum range
```

**Mathematical gotchas:**
- **Angular velocity threshold:** Mouse look can rotate ~2π rad/sec at high sensitivity. Gamepad look is slower (~π rad/sec). Set `MAX_ANGULAR_VEL = 4π` (720°/sec) as a generous ceiling. An aimbot snap of 180° in one tick (16.67ms) = ~302 rad/sec, far exceeding the threshold.
- **Float precision in heading:** `lookHeading` is f32. When heading wraps around 2π→0, the delta calculation `|h_new - h_prev|` can produce a false positive (e.g., h_prev=6.28, h_new=0.01 → delta=6.27). Must normalize: `delta = |atan2(sin(h_new - h_prev), cos(h_new - h_prev))|`.
- **Mouse delta accumulation:** The input SAB stores raw `mouseDx`/`mouseDy` which are consumed (zeroed) by the sim each tick. A cheat could write large values between the sim's read and consume. Mitigation: clamp on read, not just validate.
- **Key state race:** The renderer writes keys asynchronously to the SAB. The sim reads them at a specific point in the tick. There's no lock — but since keys are bitfield u32s, reads/writes are atomic on x86. No torn reads possible for 32-bit aligned values.

**Performance cost:** Negligible. 4 players × ~6 checks = 24 comparisons per tick. ~0.001ms. No measurable impact.

**Implementation:** New `InputValidator` class in `games/to-the-ocean/src/simulation/security/`, called at the top of `sim-worker-web.ts`'s `loop()` before `simulation.tick()`.

---

### Layer 2: SAB Integrity Checksums (sim worker, post-write)

**What it protects against:** Man-in-the-middle SAB modification between sim write and renderer read. Detects if the sim SAB has been tampered with after the sim wrote it but before the renderer consumed it.

**Mechanism:** After `writeToBuffer()`, compute a checksum over critical SAB regions and store it in reserved header space. The renderer verifies the checksum before using the data.

```
Checksum regions:
  - Sim SAB header (256 bytes): FNV-1a 32-bit hash
  - Sim SAB entity slots [0..entityCount] (entityCount × 128 bytes): FNV-1a
  - Sim SAB player slots [0..playerCount] (playerCount × 256 bytes): FNV-1a
  - Combined: store as 3 × u32 in reserved header fields (offsets 23-25)
```

**Renderer-side verification:** `SimBufferReader` gains a `verifyChecksums()` method. Called once per frame before reading entity/player data. If mismatch → renderer can flag visual desync (or just ignore — since sim overwrites next tick anyway).

**Mathematical gotchas:**
- **FNV-1a collision probability:** 32-bit hash = 2³² possible values. For ~1MB of data changing every tick, the probability of a collision per tick is ~1/2³² ≈ 2.3×10⁻¹⁰. Over 24 hours of gameplay (5.18M ticks), cumulative collision probability ≈ 1.2×10⁻³. Acceptable for detection, not for cryptographic guarantees. If false positives are unacceptable, use a 64-bit FNV-1a (store as 2× u32).
- **Entity count trust:** The checksum covers `[0..entityCount]` slots. A cheat could set `entityCount` to a lower value, checksum fewer slots, and tamper with slots beyond that range. Mitigation: checksum the header (which contains `entityCount`) separately and first, then use the validated `entityCount` for the entity region checksum.
- **Timing window:** The sim writes the SAB, then writes the checksum. The renderer reads the SAB, then reads the checksum. If a cheat modifies the SAB *and* the checksum between these two operations, the verification passes. This is a TOCTOU (time-of-check-time-of-use) race. In practice, the window is <1ms (between sim `writeToBuffer()` and renderer's next `requestAnimationFrame`), and the cheat would need to compute FNV-1a in native code within that window. This is feasible for a determined attacker but raises the bar significantly.
- **Atomics ordering:** The sim uses `Atomics.add` for the tick counter but plain writes for other header fields. Without `Atomics.store`/`Atomics.load` fences, the renderer might see a partially-written SAB with a valid checksum (memory reordering). Mitigation: use `Atomics.store` for the checksum fields, or compute checksum *after* all writes and use `Atomics.store` for the tick counter as a release fence.

**Performance cost:**
- FNV-1a over 1MB: ~0.3-0.5ms per tick (measured: FNV-1a processes ~2-3 GB/s in JS)
- At 60Hz (16.67ms budget), this is ~2-3% of the tick budget
- Optimization: only checksum active entity slots (typically 50-500, not 8192), reducing to ~0.02-0.05ms
- Renderer verification: same cost, but runs in the renderer thread (not sim thread), so no sim impact

**Implementation:** Extend `SimChannel` definition with 3 reserved u32 header fields (`checksumHeader`, `checksumEntities`, `checksumPlayers`). Add `computeChecksums()` to `SimBufferWriter`, `verifyChecksums()` to `SimBufferReader`.

---

### Layer 3: Value Range & Delta Validation (sim worker, post-tick)

**What it protects against:** Direct JS heap manipulation of `SimEntity`/`SimPlayer` objects (the hardest attack to detect, since it modifies the authoritative source).

**Mechanism:** After `simulation.tick()`, before `writeToBuffer()`, validate all entity and player fields:

```
Per entity (entityCount × ~15 checks):
  - health ∈ [0, maxHealth]
  - position: Number.isFinite(x), Number.isFinite(y), Number.isFinite(z)
  - position within world bounds: |x| < 1e7, |z| < 1e7
  - velocity magnitude ≤ MAX_VELOCITY (e.g., 500 m/s — fastest ship is ~30 m/s)
  - rotation quaternion: |q|² ≈ 1 (within ε=1e-4)
  - scale ∈ [0.01, 1000]
  - type ∈ valid EntityType enum
  - flags: no reserved/undefined bits set

Per player (playerCount × ~20 checks):
  - health ∈ [0, maxHealth]
  - hunger, thirst, oxygen ∈ [0, max*]
  - temperature ∈ [-50, 100] (gameplay range)
  - gold ≥ 0 and gold ≤ MAX_GOLD (e.g., 2^31)
  - gold delta: |gold - gold_prev| ≤ max_trade_amount × dt
    (unless a trade command was processed this tick)
  - position: Number.isFinite, within world bounds
  - position delta: |pos - pos_prev| ≤ MAX_TELEPORT_DIST
    (account for: ship boarding, respawn, noclip dev mode)
  - cameraMode ∈ valid CameraMode enum
  - flags: no undefined bits
```

**Mathematical gotchas:**
- **Quaternion normalization check:** `|q|² = x² + y² + z² + w²`. Due to float precision, this is rarely exactly 1.0. Use `||q|² - 1| < ε` with `ε = 1e-4`. A Cheat Engine user setting rotation to (0,0,0,0) would cause NaN in rendering — this check catches it.
- **Teleport detection vs legitimate movement:** Max legitimate position delta per tick:
  - Swimming: ~5 m/s × 0.0167s = 0.083m
  - Ship: ~30 m/s × 0.0167s = 0.5m
  - Noclip (dev): unlimited — must exempt when `NOCLIP` flag is set
  - Ship boarding: instant snap to ship position — must exempt when `ONBOARD` flag transitions
  - Respawn: instant position change — must exempt for 1 tick after respawn command
  - Collision push: Rapier can apply impulse-based position corrections up to ~2m/tick
  - Recommended threshold: `MAX_TELEPORT_DIST = 100m` (generous, catches only blatant teleport)
- **Gold precision gap:** `player.gold` is a JS `number` (f64, ~15-16 significant digits). The SAB stores it as `f32` (~7 significant digits). For gold > 16,777,216 (2²⁴), f32 cannot represent individual gold coins — `gold + 1` rounds to `gold`. A cheat could exploit this: set f32 SAB gold to a value that, when read back as f64, differs from the internal value. Mitigation: validate gold from the internal f64 value, not the SAB f32 value. Consider storing gold as u32 (cents) in the SAB instead of f32.
- **NaN propagation:** If a cheat sets `health = NaN` in the JS heap, all subsequent health arithmetic produces NaN. `NaN !== NaN` in JS, so range checks `health >= 0 && health <= maxHealth` return false (NaN comparisons are always false). This is actually correct behavior — the check catches it. But the error handling must use `Number.isNaN()` explicitly, not `=== NaN`.
- **Negative zero:** `-0 === 0` is true in JS, but `1/-0 = -Infinity` while `1/0 = Infinity`. For position values, -0 is harmless. For velocity, -0 could cause direction issues. Use `Object.is(x, -0)` to detect if needed.
- **Denormal floats:** Values like `1e-40` (subnormal) are valid f32 but cause ~10x slowdown in CPU operations on some architectures. A cheat could set entity velocity to denormals to cause sim slowdowns. Mitigation: `Math.fround(x) === 0` catches denormals that round to zero, but `1e-40` as f32 is a denormal. Check `Math.abs(x) < 1e-38` (smallest normal f32) and flush to zero.

**Performance cost:**
- Entity validation: 8192 entities × 15 checks = 122,880 comparisons. At ~1ns per comparison (JIT-optimized), ~0.12ms.
- Player validation: 8 players × 20 checks = 160 comparisons. Negligible.
- Quaternion magnitude: 4 multiplications + 3 additions + 1 comparison per entity = ~0.05ms for 8192 entities.
- Total: ~0.17ms per tick (~1% of tick budget).
- Optimization: skip validation for inactive entity slots (check `entity.flags & ACTIVE` first).

**Implementation:** New `StateValidator` class in `games/to-the-ocean/src/simulation/security/`. Called in `Simulation.tick()` between the last system update and `writeToBuffer()`. On violation: log, clamp to valid range, and optionally emit a `cheat_detected` event via `onEvent`.

---

### Layer 4: Sensitive Value Obfuscation (JS heap, sim worker)

**What it protects against:** Cheat Engine memory scanning of JS heap objects. Makes it harder to locate and modify specific game values (gold, health) in V8's garbage-collected heap.

**Mechanism:** Store sensitive values in an obfuscated form using XOR encryption with a per-tick rotating key:

```typescript
class ProtectedValue {
  private raw: number = 0;        // XOR-encrypted value
  private key: number = 0;        // current key (rotates each tick)

  get(): number {
    return this.raw ^ this.key;   // decrypt on read
  }

  set(v: number): void {
    this.raw = v ^ this.key;      // encrypt on write
  }

  rotateKey(newKey: number): void {
    const current = this.get();   // decrypt with old key
    this.key = newKey;            // swap key
    this.set(current);            // re-encrypt with new key
  }
}
```

Apply to: `player.gold`, `player.health`, `player.hunger`, `player.thirst`, `player.oxygen`.

**Mathematical gotchas:**
- **XOR with float bit patterns:** JS numbers are f64 (64-bit). XOR operates on 32-bit integers. To XOR a float, use `Float64Array` + `Uint32Array` view on the same `ArrayBuffer`:
  ```
  const buf = new ArrayBuffer(8);
  const f64 = new Float64Array(buf);
  const u32 = new Uint32Array(buf);
  f64[0] = value;
  u32[0] ^= key_lo;  u32[1] ^= key_hi;
  return f64[0];
  ```
  This XORs the raw IEEE 754 bit pattern. A Cheat Engine scan for a known gold value (e.g., 1000.0) would find the encrypted bit pattern instead, which changes every tick.
- **Key rotation overhead:** Rotating the key for N protected values requires N decrypt + N encrypt operations. For ~8 players × 5 sensitive values = 40 values, this is ~80 XOR operations per tick. Negligible (~0.001ms).
- **Key generation:** Use a simple PRNG seeded with `totalTicks` (e.g., xorshift32). Don't use `Math.random()` — it's not deterministic and makes debugging harder. The key doesn't need to be cryptographically secure, just unpredictable to a scanner.
- **V8 inline caching:** V8 may inline-cache the getter/setter and optimize away the XOR if it detects the pattern. To prevent this, use a `WeakMap`-based indirection or `Proxy` — but these have ~10x access overhead. For a game running at 60Hz with ~40 protected values accessed maybe 100 times per tick, the overhead is still <0.1ms.
- **Garbage collector relocation:** V8's GC can move objects in memory. This is actually a *benefit* for anti-cheat — the physical memory address of a `ProtectedValue` changes unpredictably. Cheat Engine's pointer scan would need to re-find the value after each GC cycle. However, V8's young generation GC runs frequently (~every 1-10ms), which means the pointer map changes rapidly. This is the strongest natural protection in the architecture.

**Performance cost:**
- Per-access overhead: ~5-10ns (XOR + array view) vs ~1ns for direct property access. ~5-10x slower per access.
- With ~40 protected values × ~100 accesses/tick = 4000 accesses: ~0.04ms per tick.
- Total impact: <0.5% of tick budget.
- Trade-off: makes code uglier and harder to debug. Recommend behind a flag (`config.enableAntiCheat`).

**Implementation:** New `ProtectedValue` class in `packages/core/src/security/protected-value.ts`. Replace direct `player.gold` access with `player.gold.get()` / `.set()` in systems that touch gold (trade, progression, survival). The `SimPlayer` interface gains `gold: ProtectedValue` when anti-cheat is enabled.

---

### Layer 5: WASM-Native Critical State (future, highest effort)

**What it protects against:** All JS-heap-based memory scanning. Moves the most sensitive values out of V8's heap entirely.

**Mechanism:** Extend the existing Rapier WASM module (or create a new small WASM module) to hold an authoritative state table:

```
Rust side:
  struct ProtectedState {
    gold: [f64; MAX_PLAYERS],
    health: [f64; MAX_PLAYERS],
    inventory_hashes: [u64; MAX_PLAYERS],
  }

  #[wasm_bindgen]
  impl ProtectedState {
    fn get_gold(&self, player_idx: u32) -> f64 { self.gold[player_idx as usize] }
    fn set_gold(&mut self, player_idx: u32, val: f64) { self.gold[player_idx as usize] = val }
    fn validate(&self) -> bool { /* range checks */ }
  }
```

**Why this is harder for Cheat Engine:**
- WASM memory is a single contiguous `WebAssembly.Memory` buffer (linear memory). Rust's allocator manages it internally.
- The layout depends on Rust's compilation settings (struct field order, padding, allocator behavior).
- Cheat Engine can scan WASM memory, but the offsets are not predictable — they depend on allocation order and are affected by Rust's allocator fragmentation.
- Changing the Rust crate version or compilation flags shifts all offsets, breaking saved Cheat Engine tables.
- Unlike JS heap objects, WASM memory doesn't get relocated by a GC — but the offsets are still non-obvious without reverse-engineering the WASM binary.

**Mathematical gotchas:**
- **WASM memory growth:** `WebAssembly.Memory` grows in pages (64KB). When it grows, the entire memory may be relocated (new ArrayBuffer, same `Memory` object). Cheat Engine pointers become stale. This is another natural protection — but it only triggers on growth, which may not happen during normal gameplay.
- **f64 vs f32 precision:** WASM uses f64 internally (same as JS). No precision gap between JS and WASM for gold/health. But if the SAB still stores f32, the precision gap between WASM (f64) and SAB (f32) remains. Solution: store gold as u64 cents in both WASM and SAB.
- **Inventory hash:** Instead of copying full inventory state to WASM, compute a rolling hash (e.g., polynomial hash of item IDs + quantities + slot positions). Store the hash in WASM. Each tick, recompute and compare. Mismatch → inventory tampered. Hash collision probability for a 32-bit polynomial hash with ~100 items: ~1/2³² per tick, same analysis as Layer 2.

**Performance cost:**
- WASM function call overhead: ~50-100ns per call (JS→WASM boundary).
- With 40 protected values × ~100 accesses/tick = 4000 calls: ~0.2-0.4ms per tick.
- Validation pass: ~0.01ms (runs in WASM, very fast).
- Total: ~0.4ms (~2.4% of tick budget).
- This is the most expensive layer but provides the strongest protection.

**Implementation:** New Rust crate `protected-state` in `packages/audio-native/` style (or new `packages/security-native/`). Compiled to WASM, loaded in `sim-worker-web.ts`. Access through typed wrapper. Requires `wasm-pack` build step.

---

### Layer 6: RPC Command Hardening (sim worker, command channel)

**What it protects against:** Malicious RPC commands sent from a compromised renderer (e.g., via DevTools console or injected script).

**Mechanism:**
1. **Command allowlist:** The `expose()` API in `sim-worker-web.ts` already has a fixed method set. But `sendCommand(cmd: any)` accepts arbitrary command objects. Add a command schema validator:
   - `cmd.type` must be in the known `SimCommandType` enum
   - `cmd.playerId` must match an active player
   - `cmd.payload` fields must match expected types and ranges
   - Reject commands with extra fields (strict schema)

2. **Rate limiting:** Track command frequency per player. More than N commands of the same type per second → flag. E.g., >10 trade commands/sec is suspicious.

3. **Trade validation (already partial):** `handleCommand` at `Simulation.ts:1209-1227` checks `player.gold < totalPrice` for buys. But `sellToPort` at `:1223` doesn't verify the player actually has the item in inventory. Add inventory verification.

4. **Production hardening:** Strip `(window as any).__renderer` and `(window as any).__simWorker` globals in production builds. Disable DevTools in production Electron windows.

**Mathematical gotchas:**
- **Rate limit threshold:** At 60Hz, a legitimate player can issue at most 60 commands/sec (one per tick). Most commands are user-initiated (button clicks) at ~1-5/sec. Set threshold to 20/sec for non-movement commands. Movement commands (sleep/wake) are already low-frequency.
- **Command replay:** A cheat could capture a valid trade command and replay it. Mitigation: include a monotonically increasing `commandSeq` in each command. The sim tracks the last seq per player and rejects seq ≤ last_seq.

**Performance cost:** Negligible. Command validation is ~10 field checks per command. Commands arrive at ~1-5/sec, not per-tick. ~0.0001ms average per tick.

**Implementation:** New `CommandValidator` in `games/to-the-ocean/src/simulation/security/`. Wrap the existing `sendCommand` handler in `sim-worker-web.ts`. Add `commandSeq` to `SimCommand` type.

---

## Performance Summary

| Layer | Per-tick cost | % of 16.67ms budget | What it catches |
|-------|--------------|---------------------|-----------------|
| 1. Input validation | ~0.001ms | <0.01% | Aimbots, teleport via input, input automation |
| 2. SAB checksums | ~0.05ms (active slots only) | ~0.3% | SAB tampering between write and read |
| 3. Value range validation | ~0.17ms | ~1.0% | JS heap manipulation, impossible states |
| 4. Value obfuscation | ~0.04ms | ~0.2% | Cheat Engine memory scanning |
| 5. WASM-native state | ~0.4ms (future) | ~2.4% | All JS-heap-based scanning |
| 6. RPC command hardening | ~0.0001ms | <0.01% | Malicious commands, replay attacks |
| **Total (layers 1-4,6)** | **~0.26ms** | **~1.6%** | |
| **Total (all layers)** | **~0.66ms** | **~4.0%** | |

All layers fit comfortably within the 16.67ms tick budget. The sim's current tick time is typically 2-8ms (based on the `> 50ms` slow-tick threshold at `Simulation.ts:579`), leaving 8-14ms of headroom.

---

## Implementation Phases

### Phase 1: Detection (Layers 1, 3, 6)
- Input validation before tick
- Value range validation after tick
- RPC command hardening
- All violations logged + emitted as `cheat_detected` events
- No behavior change — just detection and logging
- **Effort:** ~2-3 days. No new dependencies. Pure TS.

### Phase 2: Obfuscation (Layers 2, 4)
- SAB integrity checksums (sim + renderer sides)
- ProtectedValue wrapper for gold/health/survival stats
- Key rotation per tick
- **Effort:** ~3-4 days. No new dependencies. Pure TS.

### Phase 3: WASM Hardening (Layer 5)
- Rust crate for protected state
- WASM build pipeline integration
- Migrate gold/health/inventory hashes to WASM memory
- **Effort:** ~5-7 days. Requires `wasm-pack` / `rustc` in build pipeline.

### Phase 4: Production Hardening
- Strip debug globals in production
- Disable DevTools in production Electron
- Obfuscate SAB layout (randomize field order per build)
- Add `enableAntiCheat` config flag (default: on in production, off in dev)
- **Effort:** ~1-2 days.

---

## What This Does NOT Protect Against

- **DLL injection / process hollowing:** A cheat that injects into the Electron process can hook any function, including V8 internals. This is beyond the scope of application-level protection.
- **Renderer-side visual cheats:** Wallhacks, ESP, custom shaders that read entity positions from the SAB. The SAB is intentionally readable by the renderer. Mitigation: only send entity data for entities within the player's view frustum + fog distance (server-side culling). This is a rendering concern, not a sim concern.
- **Timing attacks:** A cheat that measures sim tick timing to infer entity positions (e.g., "physics took longer → more entities near me"). Mitigation: constant-time tick execution (pad to fixed duration). Not practical at 60Hz.
- **Multiplayer authority:** This plan is for single-player. For multiplayer, the sim worker pattern extends to a server-side authoritative sim. The same protection layers apply, but the server is the source of truth, not the client.
