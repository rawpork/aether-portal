// Entry point for the spatial view modules (SPATIAL_ARCHITECTURE.md, section 4.1). The portal's inline script
// talks to them only through window.AetherSpatial, and waits for the 'aether-spatial-ready' event because module
// scripts run after it.
import { readDocumentTokens } from './tokens.js';
import { GROUP_KEYS, buildHierarchy, groupColor } from './grouping.js';
import { closeGroupPicker, createGroupPicker } from './group-picker.js';
import { CameraRig, createViewer, fitRectDistance, fitSphereDistance, uncoveredTarget } from './camera-rig.js';
import { faceFromNode } from './card-faces.js';
import { CARD_HEIGHT, CARD_WIDTH, createCardField, createCollideForce } from './card-nodes.js';
import { galleryLayout, slotToWorld, yawToward } from './layout-gallery.js';
import { OUTCOME_CATEGORY, computeHubWeights, hubScale } from './hub-weights.js';
import { lodFactor } from './lod.js';
import { boardLayout, columnAt } from './layout-2d.js';
import { mapLayout, wirePoints } from './layout-map.js';
import { galleryPlacement, overviewPlacement } from './xr-math.js';
import { createXR, xrSupport } from './xr.js';
import { DEPTHS, primaryGroup, visibleLinks } from './depth.js';
import { isPlayable, parseMedia } from './media.js';
import { FACE_HEIGHT, FACE_WIDTH, MEDIA_BAND } from './card-faces.js';

window.AetherSpatial = {
  boardLayout,
  columnAt,
  mapLayout,
  wirePoints,
  xrSupport,
  createXR,
  DEPTHS,
  primaryGroup,
  visibleLinks,
  isPlayable,
  parseMedia,
  FACE_WIDTH,
  FACE_HEIGHT,
  MEDIA_BAND,
  galleryPlacement,
  overviewPlacement,
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
  uncoveredTarget,
  faceFromNode,
  CARD_WIDTH,
  CARD_HEIGHT,
  createCardField,
  createCollideForce,
  galleryLayout,
  slotToWorld,
  yawToward,
  computeHubWeights,
  hubScale,
  OUTCOME_CATEGORY,
  lodFactor
};
window.dispatchEvent(new Event('aether-spatial-ready'));
