import type { AnimationClip } from "./clip.ts";
import type { AnimationPlayer } from "./player.ts";

export interface BlendTree1D {
  type: "1d";
  parameter: string;
  children: Array<{ clip: AnimationClip; threshold: number }>;
}

export interface BlendTree2D {
  type: "2d";
  parameterX: string;
  parameterY: string;
  children: Array<{ clip: AnimationClip; position: [number, number] }>;
}

export type BlendTree = BlendTree1D | BlendTree2D;

export interface AnimationState {
  name: string;
  clip?: AnimationClip;
  blendTree?: BlendTree;
  speed: number;
  loop: boolean;
  weight: number;
  boneMask: number[] | null;
  additive: boolean;
}

export interface AnimationTransition {
  from: string;
  to: string;
  duration: number;
  conditions: Array<{ parameter: string; op: ">" | "<" | "==" | "!=" | ">=" | "<="; value: number }>;
  exitTime?: number;
}

export class AnimationStateMachine {
  private states: Map<string, AnimationState> = new Map();
  private transitions: AnimationTransition[] = [];
  private currentState: string | null = null;
  private previousState: string | null = null;
  private transitionTime = 0;
  private transitionDuration = 0;
  private transitioning = false;
  private parameters: Map<string, number> = new Map();
  private player: AnimationPlayer | null = null;

  constructor(player?: AnimationPlayer) {
    this.player = player ?? null;
  }

  addState(name: string, opts?: { clip?: AnimationClip; weight?: number; blendTree?: BlendTree; speed?: number; loop?: boolean; boneMask?: number[]; additive?: boolean }): void {
    this.states.set(name, {
      name,
      clip: opts?.clip,
      blendTree: opts?.blendTree,
      speed: opts?.speed ?? 1,
      loop: opts?.loop ?? true,
      weight: opts?.weight ?? 1,
      boneMask: opts?.boneMask ?? null,
      additive: opts?.additive ?? false,
    });
  }

  addTransition(from: string, to: string, opts: { duration: number; conditions: Array<{ parameter: string; op: ">" | "<" | "==" | "!=" | ">=" | "<="; value: number }>; exitTime?: number }): void {
    this.transitions.push({ from, to, duration: opts.duration, conditions: opts.conditions, exitTime: opts.exitTime });
  }

  setInitialState(name: string): void {
    if (!this.states.has(name)) throw new Error(`State "${name}" not found`);
    this.currentState = name;
    this.transitioning = false;
    this.playState(name, 1, 0);
  }

  setParameter(name: string, value: number): void {
    this.parameters.set(name, value);
  }

  getParameter(name: string): number {
    return this.parameters.get(name) ?? 0;
  }

  start(stateName: string): void {
    this.setInitialState(stateName);
  }

  update(dt: number, params?: Record<string, number>): void {
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        this.setParameter(k, v);
      }
    }
    if (!this.currentState) return;

    if (this.transitioning) {
      this.transitionTime += dt;
      const alpha = Math.min(1, this.transitionTime / this.transitionDuration);
      if (this.player) {
        const prevClip = this.getStateClip(this.previousState!);
        const currClip = this.getStateClip(this.currentState!);
        if (prevClip) this.player.setWeight(this.previousState!, 1 - alpha);
        if (currClip) this.player.setWeight(this.currentState!, alpha);
      }

      if (alpha >= 1) {
        if (this.player) {
          const prevClip = this.getStateClip(this.previousState!);
          if (prevClip) this.player.stop(this.previousState!);
        }
        this.transitioning = false;
        this.previousState = null;
      }
    }

    this.updateBlendTrees(dt);

    if (!this.transitioning) {
      this.checkTransitions();
    }
  }

  getCurrentState(): string | null {
    return this.currentState;
  }

  isTransitioning(): boolean {
    return this.transitioning;
  }

  private playState(name: string, weight: number, fadeDuration: number): void {
    const state = this.states.get(name);
    if (!state) return;
    const clip = this.getStateClip(name);
    if (clip && this.player) {
      this.player.play(name, clip, { speed: state.speed, weight, loop: state.loop, fadeDuration, boneMask: state.boneMask ?? undefined, additive: state.additive });
    }
  }

  private getStateClip(name: string): AnimationClip | undefined {
    const state = this.states.get(name);
    if (!state) return undefined;
    if (state.clip) return state.clip;
    if (state.blendTree) {
      const clips = this.getActiveBlendClips(state.blendTree);
      return clips[0]?.clip;
    }
    return undefined;
  }

  private getActiveBlendClips(tree: BlendTree): Array<{ clip: AnimationClip; weight: number }> {
    if (tree.type === "1d") {
      const param = this.getParameter(tree.parameter);
      const sorted = [...tree.children].sort((a, b) => a.threshold - b.threshold);

      if (param <= sorted[0].threshold) return [{ clip: sorted[0].clip, weight: 1 }];
      if (param >= sorted[sorted.length - 1].threshold) return [{ clip: sorted[sorted.length - 1].clip, weight: 1 }];

      for (let i = 0; i < sorted.length - 1; i++) {
        if (param >= sorted[i].threshold && param <= sorted[i + 1].threshold) {
          const range = sorted[i + 1].threshold - sorted[i].threshold;
          const alpha = range > 0 ? (param - sorted[i].threshold) / range : 0;
          return [
            { clip: sorted[i].clip, weight: 1 - alpha },
            { clip: sorted[i + 1].clip, weight: alpha },
          ];
        }
      }
      return [{ clip: sorted[0].clip, weight: 1 }];
    } else {
      const px = this.getParameter(tree.parameterX);
      const py = this.getParameter(tree.parameterY);
      const children = tree.children;
      if (children.length === 0) return [];
      if (children.length === 1) return [{ clip: children[0].clip, weight: 1 }];

      let closest = 0;
      let secondClosest = 1;
      let dist0 = Infinity;
      let dist1 = Infinity;
      for (let i = 0; i < children.length; i++) {
        const dx = children[i].position[0] - px;
        const dy = children[i].position[1] - py;
        const d = dx * dx + dy * dy;
        if (d < dist0) {
          secondClosest = closest;
          dist1 = dist0;
          closest = i;
          dist0 = d;
        } else if (d < dist1) {
          secondClosest = i;
          dist1 = d;
        }
      }

      const total = dist0 + dist1;
      const w0 = total > 0 ? dist1 / total : 1;
      const w1 = total > 0 ? dist0 / total : 0;
      return [
        { clip: children[closest].clip, weight: w0 },
        { clip: children[secondClosest].clip, weight: w1 },
      ];
    }
  }

  private updateBlendTrees(dt: number): void {
    if (!this.currentState) return;
    const state = this.states.get(this.currentState);
    if (!state || !state.blendTree || !this.player) return;

    const activeClips = this.getActiveBlendClips(state.blendTree);
    for (const { clip, weight } of activeClips) {
      if (!this.player.isPlaying(clip)) {
        this.player.play(state.name, clip, { speed: state.speed, weight, loop: state.loop });
      }
      this.player.setWeight(state.name, weight);
    }
  }

  private checkTransitions(): void {
    if (!this.currentState) return;

    for (const t of this.transitions) {
      if (t.from !== this.currentState) continue;

      let allMet = true;
      for (const cond of t.conditions) {
        const val = this.getParameter(cond.parameter);
        switch (cond.op) {
          case ">": if (!(val > cond.value)) allMet = false; break;
          case "<": if (!(val < cond.value)) allMet = false; break;
          case "==": if (!(val === cond.value)) allMet = false; break;
          case "!=": if (!(val !== cond.value)) allMet = false; break;
          case ">=": if (!(val >= cond.value)) allMet = false; break;
          case "<=": if (!(val <= cond.value)) allMet = false; break;
        }
        if (!allMet) break;
      }

      if (allMet) {
        this.triggerTransition(t);
        return;
      }
    }
  }

  private triggerTransition(t: AnimationTransition): void {
    this.previousState = this.currentState;
    this.currentState = t.to;
    this.transitioning = true;
    this.transitionTime = 0;
    this.transitionDuration = t.duration;

    const targetClip = this.getStateClip(t.to);
    if (targetClip && this.player) {
      const state = this.states.get(t.to);
      this.player.play(t.to, targetClip, {
        speed: state?.speed ?? 1,
        weight: 0,
        loop: state?.loop ?? true,
        fadeDuration: 0,
        boneMask: state?.boneMask ?? undefined,
        additive: state?.additive,
      });
    }
  }
}
