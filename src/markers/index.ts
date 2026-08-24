// Public API for the marker overlay — the overview's location pins/tags.
// See service.ts's own comment for the split with usMap.js: this owns 2D
// DOM presentation (pixel-art pin styling, label collision/decluttering),
// usMap.js still owns projecting each location's real position into screen
// space and its own globe-specific visibility rules (behind the horizon,
// off-screen).
export {
  createMarkerOverlay, type MarkerOverlay, type MarkerDescriptor, type MarkerProjection,
} from './service';
