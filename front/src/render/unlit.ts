// The scene is lit with physical values: sunlit white ground has a radiance of
// about 0.1, and the camera exposure brings that up to white. Overlays that
// are not lit (route ribbon, hazard decals, scan beams) use this as "white",
// and run through the same tone mapping, so they never burn out.
export const UNLIT = 0.15;
