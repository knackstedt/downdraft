// ============================================================================
// Anim display — direct-DOM update channel for the animation scrubber + time
// text. The frame loop calls update() every frame; the AnimationPanel
// registers its DOM elements via register(). This avoids React re-renders
// during animation playback (which pegged CPU at 100% and caused stutter).
// ============================================================================

interface AnimDisplayElements {
  scrubber: HTMLInputElement | null;
  timeText: HTMLElement | null;
  duration: number;
}

const elements: AnimDisplayElements = {
  scrubber: null,
  timeText: null,
  duration: 0,
};

/** Register the scrubber + time-text DOM elements. Pass nulls to unregister. */
export function registerAnimDisplay(
  scrubber: HTMLInputElement | null,
  timeText: HTMLElement | null,
  duration: number,
): void {
  elements.scrubber = scrubber;
  elements.timeText = timeText;
  elements.duration = duration;
}

/** Update the scrubber position + time text directly via the DOM (no React). */
export function updateAnimDisplay(time: number, duration: number): void {
  elements.duration = duration;
  const clamped = duration > 0 ? Math.min(time, duration) : 0;
  const scrubber = elements.scrubber;
  // Only write the scrubber value if the user isn't actively dragging it
  // (avoids fighting the user's pointer). We detect this by checking
  // activeElement + that the value differs — cheap and good enough.
  if (scrubber && document.activeElement !== scrubber) {
    if (scrubber.max !== String(duration > 0 ? duration : 0)) {
      scrubber.max = String(duration > 0 ? duration : 0);
      scrubber.step = String(duration > 0 ? duration / 1000 : 1);
    }
    scrubber.value = String(clamped);
  }
  const timeText = elements.timeText;
  if (timeText) {
    timeText.textContent = `${clamped.toFixed(2)}s / ${duration.toFixed(2)}s`;
  }
}
