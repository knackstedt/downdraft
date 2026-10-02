// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// nodejs-mobile: polyfill for std::atomic_ref on Android libc++.
//
// Android libc++ in NDK r27/r28 ships with std::atomic_ref disabled — the
// __atomic/atomic_ref.h pieces are simply absent and __cpp_lib_atomic_ref
// stays undefined. NDK r30 restored it; the guard below makes this header a
// no-op there. V8 uses std::atomic_ref in
// src/base/atomicops.h, cppgc headers, and a few other places since V8 13.x.
// Chrome never notices because V8-on-Android is built with Chromium's own
// bundled libc++, not the NDK's.
//
// This header provides a drop-in std::atomic_ref<T> implemented by
// reinterpreting the referent as std::atomic<T> — the same mechanism the
// real libc++/libstdc++ implementations use internally (std::atomic<T> and
// T are layout-compatible for integral and pointer types on every shipping
// toolchain). Guarded so it never collides with a conforming <atomic> and
// never affects non-Android builds.
//
// Only the member functions V8 actually calls are provided: load, store,
// exchange, compare_exchange_{strong,weak}, fetch_{add,sub,and,or,xor}.
// wait/notify_* are intentionally omitted — Android libc++ also lacks the
// _LIBCPP_AVAILABILITY_HAS_SYNC platform wait support they need, and V8
// does not call them on atomic_ref.

#ifndef SRC_BASE_ATOMIC_REF_SHIM_H_
#define SRC_BASE_ATOMIC_REF_SHIM_H_

#include <atomic>
#include <cstddef>
#include <type_traits>

#if defined(__ANDROID__) && !defined(__cpp_lib_atomic_ref)

namespace std {

template <typename T>
struct atomic_ref {
  static_assert(
      is_integral_v<T> || is_pointer_v<T> || is_enum_v<T>,
      "atomic-ref-shim: V8 only uses atomic_ref on integral/enum/pointer types");

  // Matches the real std::atomic_ref contract.
  static constexpr size_t required_alignment = alignof(T);
  static constexpr bool is_always_lock_free =
      atomic<T>::is_always_lock_free;

  explicit atomic_ref(T& obj) noexcept
      : ptr_(reinterpret_cast<atomic<T>*>(&obj)) {}
  atomic_ref(const atomic_ref&) noexcept = default;
  atomic_ref& operator=(const atomic_ref&) = delete;

  T load(memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->load(order);
  }
  void store(T desired,
             memory_order order = memory_order_seq_cst) const noexcept {
    ptr_->store(desired, order);
  }
  T exchange(T desired,
             memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->exchange(desired, order);
  }
  bool compare_exchange_strong(
      T& expected, T desired,
      memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->compare_exchange_strong(expected, desired, order);
  }
  bool compare_exchange_strong(T& expected, T desired,
                               memory_order success,
                               memory_order failure) const noexcept {
    return ptr_->compare_exchange_strong(expected, desired, success, failure);
  }
  bool compare_exchange_weak(
      T& expected, T desired,
      memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->compare_exchange_weak(expected, desired, order);
  }
  bool compare_exchange_weak(T& expected, T desired,
                             memory_order success,
                             memory_order failure) const noexcept {
    return ptr_->compare_exchange_weak(expected, desired, success, failure);
  }

  // fetch_* — integral/enum members; pointer overloads take ptrdiff_t.
  template <typename U = T>
    requires(!is_pointer_v<U>)
  T fetch_add(T arg,
              memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->fetch_add(static_cast<T>(arg), order);
  }
  template <typename U = T>
    requires(is_pointer_v<U>)
  T fetch_add(ptrdiff_t arg,
              memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->fetch_add(arg, order);
  }
  template <typename U = T>
    requires(!is_pointer_v<U>)
  T fetch_sub(T arg,
              memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->fetch_sub(static_cast<T>(arg), order);
  }
  template <typename U = T>
    requires(is_pointer_v<U>)
  T fetch_sub(ptrdiff_t arg,
              memory_order order = memory_order_seq_cst) const noexcept {
    return ptr_->fetch_sub(arg, order);
  }
  T fetch_and(T arg,
              memory_order order = memory_order_seq_cst) const noexcept
    requires(is_integral_v<T>)
  {
    return ptr_->fetch_and(arg, order);
  }
  T fetch_or(T arg,
             memory_order order = memory_order_seq_cst) const noexcept
    requires(is_integral_v<T>)
  {
    return ptr_->fetch_or(arg, order);
  }
  T fetch_xor(T arg,
              memory_order order = memory_order_seq_cst) const noexcept
    requires(is_integral_v<T>)
  {
    return ptr_->fetch_xor(arg, order);
  }

 private:
  atomic<T>* ptr_;
};

}  // namespace std

// Advertise the feature so capability checks that gate code on
// std::atomic_ref (e.g. simdutf's SIMDUTF_ATOMIC_REF / atomic_base64_*)
// enable their paths — the shim provides the ops they use.
#define __cpp_lib_atomic_ref 201806L

#endif  // __ANDROID__ && !__cpp_lib_atomic_ref

#endif  // SRC_BASE_ATOMIC_REF_SHIM_H_
