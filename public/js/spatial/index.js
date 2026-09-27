// Entry point for the spatial view modules (SPATIAL_ARCHITECTURE.md, section 4.1). The portal's inline script
// talks to them only through window.AetherSpatial, and waits for the 'aether-spatial-ready' event because module
// scripts run after it.
import { readDocumentTokens } from './tokens.js';
import { GROUP_KEYS, buildHierarchy, groupColor } from './grouping.js';
import { closeGroupPicker, createGroupPicker } from './group-picker.js';
import { CameraRig, createViewer, fitRectDistance, fitSphereDistance, uncoveredTarget } from './camera-rig.js';

window.AetherSpatial = {
  tokens: readDocumentTokens(),
  GROUP_KEYS,
  buildHierarchy,
  groupColor,
  createGroupPicker,
  closeGroupPicker,
  CameraRig,
  createViewer,
  fitSphereDistance,
  fitRectDistance,
  uncoveredTarget
};
window.dispatchEvent(new Event('aether-spatial-ready'));
