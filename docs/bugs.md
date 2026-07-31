Phase 1: Core Infrastructure (no gameplay changes)
Create LightSystem.ts with storage buffer, point/spot light structs, CPU culling
Add LightStorage WGSL struct + applyDynamicLights function
Add storage buffer binding to all 5 entity pipelines (new bind group layout)
Update entityLighting and islandLighting to call applyDynamicLights
Wire LightSystem into WebGPURenderer.renderViewport()
Test: register a single hardcoded point light at player position, verify it illuminates nearby geometry
Phase 2: Light Source Integration
Player flashlight (spot light from camera direction)
Boat lantern cells (point lights at LANTERN cell positions)
Bioluminescent entities (point lights from EntityFlags.Bioluminescent)
Port lights (point lights at port structures)
Phase 3: Polish
Water system sun direction consistency fix
Light intensity pulsing (flicker for lanterns, pulse for bioluminescence)
Light debug visualization (sphere gizmos showing light radius)
Water dynamic light reflections (optional)












Underwater lighting is kinda fucked
(jellyfish emissivity, flashlight ...)