---
title: Animation
description: Animation system with skeletal animation, state machines, and retargeting
---

DownDraft provides a comprehensive animation system with skeletal animation, GLTF skinning, GPU compute skinning, and Mixamo retargeting.

## AnimationPlayer

```typescript
import { AnimationPlayer } from "@downdraft/engine";

const player = new AnimationPlayer();
player.play("idle", { weight: 1.0, fadeIn: 0.2 });
```

## State Machine

```typescript
import { AnimationStateMachine } from "@downdraft/engine";

const sm = new AnimationStateMachine();
sm.addState("idle", { clip: idleClip });
sm.addState("walk", { clip: walkClip });
sm.addTransition("idle", "walk", { condition: "speed > 0.5" });
```

## Features

- **Skeletal animation** — Keyframe tracks for bone transforms
- **GLTF skinning** — Automatic skinning from GLTF/GLB files
- **GPU compute skinning** — Bone transforms computed on GPU for performance
- **Mixamo retargeting** — Strip `mixamorig:` prefix, T-pose to A-pose calibration, cached bone-mapping table
- **Blend trees** — 1D and 2D blend trees for smooth transitions between animations

## Animation Clips

Animation clips contain keyframe tracks — one per animated property (position, rotation, scale) per bone. Clips can be loaded from GLTF files or created programmatically.

## Skeleton

A skeleton defines the bone hierarchy and bind poses. Skeletons are shared across entities that use the same rig.

## Retargeting

The retargeting system allows animations created for one skeleton to be applied to another. Mixamo-specific retargeting handles:

- Stripping the `mixamorig:` prefix from bone names
- T-pose to A-pose calibration
- Cached bone-mapping tables for performance
