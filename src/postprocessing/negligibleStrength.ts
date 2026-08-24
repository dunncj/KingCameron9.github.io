// Shared by every situational pass (god rays, wind blur, zoom blur): each
// one is a no-op the vast majority of frames (calm weather, no active
// flight, sun below the horizon), and running a full-screen shader that
// blends in a value below this just burns GPU time on something
// imperceptible. Passes below this threshold get `.enabled = false`
// instead, skipping their draw and render-target swap entirely.
export const NEGLIGIBLE_STRENGTH = 0.001;
