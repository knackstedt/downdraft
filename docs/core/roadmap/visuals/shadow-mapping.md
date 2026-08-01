# Shadow Mapping — Future Enhancement

## Status
Not implemented. Documented as a future enhancement for the entity lighting system.

## Overview
Shadow mapping would add cast shadows from islands, boats, decorations, and other entities onto the water surface and each other, dramatically improving depth perception and visual grounding.

## Current Lighting (Implemented)
The entity lighting system uses:
- **Per-face vertex normals** (pre-computed in mesh generation, not screen-space derivatives)
- **Dynamic sun direction** from `LightingSystem.getLightingParams()` (varies with time of day)
- **Hemisphere ambient** (sky tint vs. ground tint based on normal direction)
- **Blinn-Phong specular** highlights (sun glints on facets, matching water shader style)
- **Distance fog** (color blend to fog color at far distances)

## Proposed Shadow Mapping Approach

### 1. Shadow Pass
- Render entity depth from the sun's perspective into a shadow map texture
- Use an orthographic projection covering the visible area around the camera
- Shadow map resolution: 2048×2048 (balance quality vs. performance)
- Render all entity types (islands, boats, decorations, ports) into the shadow pass

### 2. Shadow Uniform Updates
- Add shadow view-projection matrix to the uniform buffer
- Add shadow map texture binding to entity bind groups
- Add shadow parameters (bias, texel size) for PCF sampling

### 3. Shadow Sampling in Fragment Shaders
- Transform world position to shadow space
- Sample shadow map with percentage-closer filtering (PCF) for soft edges
- Apply shadow factor to diffuse and specular lighting (not ambient)
- Use a light-space bias to prevent shadow acne

### 4. Pipeline Changes
- Create a shadow-only render pipeline (depth-only, no color targets)
- Add shadow map texture to the render pass attachments
- Bind shadow map as read-only texture in entity fragment shaders

### 5. Considerations
- **Performance**: Shadow pass doubles entity draw calls. Consider rendering only large entities (islands, boats) into the shadow map and skipping small decorations.
- **Resolution**: Cascaded shadow maps (CSM) could improve near-field shadow quality for a large ocean scene.
- **Weather**: Reduce shadow intensity in overcast/storm conditions (diffuse shadows from scattered light).
- **Self-shadowing**: Low-poly faceted geometry may produce harsh self-shadows. A small slope-scale bias can help.
- **Water interaction**: The water shader would also need shadow sampling for boats/islands casting shadows on the water.
