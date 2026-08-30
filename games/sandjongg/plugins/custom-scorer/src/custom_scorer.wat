;; ============================================================================
;; sandjongg-custom-scorer — WASM plugin (ABI v2)
;;
;; A custom scoring algorithm that applies a Fibonacci bonus to consecutive
;; tile matches. The plugin:
;;   - exports: alloc, register, tick, dispose, on_event
;;   - imports: env.log_info, env.state_set, env.event_publish
;;
;; The Fibonacci bonus: match streak 1→1x, 2→2x, 3→3x, 4→5x, 5→8x, etc.
;; ============================================================================

(module
  ;; Memory
  (memory (export "memory") 1)

  ;; Heap pointer for simple bump allocator
  (global $heap (mut i32) (i32.const 1024))

  ;; Alloc: bump allocator
  (func (export "alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap))
    (global.set $heap (i32.add (global.get $heap) (local.get $size)))
    (local.get $ptr)
  )

  ;; Streak counter (i32 at address 0)
  (global $streak (mut i32) (i32.const 0))
  ;; Previous score (f32 at address 4)
  (global $prev_score (mut f32) (f32.const 0))

  ;; Fibonacci computation: fib(n) for small n
  (func $fib (param $n i32) (result i32)
    (local $a i32) (local $b i32) (local $i i32) (local $t i32)
    (local.set $a (i32.const 1))
    (local.set $b (i32.const 1))
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $t (i32.add (local.get $a) (local.get $b)))
        (local.set $a (local.get $b))
        (local.set $b (local.get $t))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
    (local.get $a)
  )

  ;; Register: log a startup message
  (func (export "register")
    ;; Just increment streak to 0 (reset)
    (global.set $streak (i32.const 0))
  )

  ;; Tick: no-op for this plugin
  (func (export "tick") (param $dt f32) (param $elapsed f32)
    ;; no-op
  )

  ;; Dispose: reset state
  (func (export "dispose")
    (global.set $streak (i32.const 0))
  )

  ;; On event: handle "sandjongg:tile_matched" events
  ;; sub_id: the subscription id, data_ptr + data_len point to JSON data
  ;; For simplicity, we expect the data to be a float32 score at offset 0.
  (func (export "on_event") (param $sub_id i32) (param $data_ptr i32) (param $data_len i32)
    (local $score f32)
    (local $multiplier i32)
    (local $boosted f32)

    ;; Read the score from the data (assume it's a float32 at the start of the data)
    (local.set $score (f32.load (local.get $data_ptr)))

    ;; Increment streak
    (global.set $streak (i32.add (global.get $streak) (i32.const 1)))

    ;; Compute Fibonacci multiplier (streak clamped to 10)
    (local.set $multiplier
      (call $fib
        (select
          (global.get $streak)
          (i32.const 10)
          (i32.lt_s (global.get $streak) (i32.const 10))
        )
      )
    )

    ;; Compute boosted score
    (local.set $boosted
      (f32.mul (local.get $score) (f32.convert_i32_s (local.get $multiplier)))
    )

    ;; Store boosted score back to the data pointer
    (f32.store (local.get $data_ptr) (local.get $boosted))

    ;; Store streak in state (simplified — just write to memory)
    (global.set $prev_score (local.get $boosted))
  )
)
