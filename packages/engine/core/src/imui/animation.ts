export type EasingFunction = (t: number) => number;

export const Easing = {
  linear: (t: number) => t,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeInOutQuad: (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic: (t: number) => t * t * t,
  easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export interface UIAnimationConfig {
  duration: number;
  easing: EasingFunction;
  from: number;
  to: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
  delay?: number;
  loop?: boolean;
  yoyo?: boolean;
}

interface ActiveAnimation {
  config: UIAnimationConfig;
  elapsed: number;
  finished: boolean;
  reverse: boolean;
}

export class UIAnimationManager {
  private animations: ActiveAnimation[] = [];

  animate(config: UIAnimationConfig): () => void {
    const anim: ActiveAnimation = {
      config,
      elapsed: 0,
      finished: false,
      reverse: false,
    };
    this.animations.push(anim);
    return () => {
      anim.finished = true;
    };
  }

  update(dt: number): void {
    for (let i = this.animations.length - 1; i >= 0; i--) {
      const anim = this.animations[i];
      if (anim.finished) {
        this.animations.splice(i, 1);
        continue;
      }

      const delay = anim.config.delay ?? 0;
      if (anim.elapsed < delay) {
        anim.elapsed += dt;
        continue;
      }

      const progressElapsed = anim.elapsed - delay;
      const t = Math.min(progressElapsed / anim.config.duration, 1);
      const eased = anim.config.easing(t);

      if (anim.reverse) {
        const value = anim.config.from + (anim.config.to - anim.config.from) * (1 - eased);
        anim.config.onUpdate(value);
      } else {
        const value = anim.config.from + (anim.config.to - anim.config.from) * eased;
        anim.config.onUpdate(value);
      }

      if (t >= 1) {
        if (anim.config.yoyo) {
          anim.reverse = !anim.reverse;
          anim.elapsed = delay;
        } else if (anim.config.loop) {
          anim.elapsed = delay;
        } else {
          anim.finished = true;
          anim.config.onComplete?.();
        }
      } else {
        anim.elapsed += dt;
      }
    }
  }

  clear(): void {
    this.animations.forEach((anim) => {
      anim.finished = true;
    });
    this.animations = [];
  }

  get count(): number {
    return this.animations.length;
  }
}

export class UIPropertyTween {
  private target: object;
  private property: string;
  private from: number;
  private to: number;
  private duration: number;
  private easing: EasingFunction;
  private elapsed: number = 0;
  private finished: boolean = false;
  onComplete?: () => void;

  constructor(target: object, property: string, from: number, to: number, duration: number, easing: EasingFunction = Easing.easeInOutCubic) {
    this.target = target;
    this.property = property;
    this.from = from;
    this.to = to;
    this.duration = duration;
    this.easing = easing;
  }

  update(dt: number): boolean {
    if (this.finished) return true;
    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.duration, 1);
    const eased = this.easing(t);
    const value = this.from + (this.to - this.from) * eased;
    (this.target as Record<string, number>)[this.property] = value;
    if (t >= 1) {
      this.finished = true;
      this.onComplete?.();
    }
    return this.finished;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

export class UILerpController {
  private tweens: UIPropertyTween[] = [];

  tween(target: object, property: string, to: number, duration: number, easing?: EasingFunction): void {
    const current = (target as Record<string, number>)[property];
    const tween = new UIPropertyTween(target, property, current, to, duration, easing);
    this.tweens.push(tween);
  }

  update(dt: number): void {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      if (this.tweens[i].update(dt)) {
        this.tweens.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.tweens = [];
  }
}
