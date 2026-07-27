// ============================================================================
// MarchingCubes — extract triangle mesh from 3D density field
// Standard 256-case lookup tables + edge interpolation.
// ============================================================================

// Edge table: for each of 256 cube configurations, which of 12 edges are crossed
const EDGE_TABLE = new Uint32Array([
0x000,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
0x190,0x099,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
0x230,0x339,0x033,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
0x3a0,0x2a9,0x1a3,0x0aa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
0x460,0x569,0x663,0x76a,0x066,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0x0ff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
0x650,0x759,0x453,0x55a,0x256,0x35f,0x055,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0x0cc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0x0cc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x055,0x35f,0x256,0x55a,0x453,0x759,0x650,
0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0x0ff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x066,0x76a,0x663,0x569,0x460,
0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0x0aa,0x1a3,0x2a9,0x3a0,
0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x033,0x339,0x230,
0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x099,0x190,
0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x000,
]);

// Triangle table: for each of 256 configs, list of edge indices forming triangles.
// Up to 5 triangles (15 values) per config, -1 terminated. Flat Int8Array for cache efficiency.
const TRI_TABLE: Int8Array = new Int8Array([
-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,8,3,9,8,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,2,10,0,2,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,8,3,2,10,8,10,9,8,-1,-1,-1,-1,-1,-1,-1,
3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,11,2,8,11,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,9,0,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,11,2,1,9,11,9,8,11,-1,-1,-1,-1,-1,-1,-1,
3,10,1,11,10,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,10,1,0,8,10,8,11,10,-1,-1,-1,-1,-1,-1,-1,
3,9,0,3,11,9,11,10,9,-1,-1,-1,-1,-1,-1,-1,
9,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,3,0,7,3,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,1,9,4,7,1,7,3,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,4,7,3,0,4,1,2,10,-1,-1,-1,-1,-1,-1,-1,
9,2,10,9,0,2,8,4,7,-1,-1,-1,-1,-1,-1,-1,
2,10,9,2,9,7,2,7,3,7,9,4,-1,-1,-1,-1,
8,4,7,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,4,7,11,2,4,2,0,4,-1,-1,-1,-1,-1,-1,-1,
9,0,1,8,4,7,2,3,11,-1,-1,-1,-1,-1,-1,-1,
4,7,11,9,4,11,9,11,2,9,2,1,-1,-1,-1,-1,
3,10,1,3,11,10,7,8,4,-1,-1,-1,-1,-1,-1,-1,
1,11,10,1,4,11,1,0,4,7,11,4,-1,-1,-1,-1,
4,7,8,9,0,11,9,11,10,11,0,3,-1,-1,-1,-1,
4,7,11,4,11,9,9,11,10,-1,-1,-1,-1,-1,-1,-1,
9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,5,4,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,5,4,1,5,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,5,4,8,3,5,3,1,5,-1,-1,-1,-1,-1,-1,-1,
1,2,10,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,8,1,2,10,4,9,5,-1,-1,-1,-1,-1,-1,-1,
5,2,10,5,4,2,4,0,2,-1,-1,-1,-1,-1,-1,-1,
2,10,5,3,2,5,3,5,4,3,4,8,-1,-1,-1,-1,
9,5,4,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,11,2,0,8,11,4,9,5,-1,-1,-1,-1,-1,-1,-1,
0,5,4,0,1,5,2,3,11,-1,-1,-1,-1,-1,-1,-1,
2,1,5,2,5,8,2,8,11,4,8,5,-1,-1,-1,-1,
10,3,11,10,1,3,9,5,4,-1,-1,-1,-1,-1,-1,-1,
4,9,5,0,8,1,8,10,1,8,11,10,-1,-1,-1,-1,
5,4,0,5,0,11,5,11,10,11,0,3,-1,-1,-1,-1,
5,4,8,5,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,
9,7,8,5,7,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,3,0,9,5,3,5,7,3,-1,-1,-1,-1,-1,-1,-1,
0,7,8,0,1,7,1,5,7,-1,-1,-1,-1,-1,-1,-1,
1,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,7,8,9,5,7,10,1,2,-1,-1,-1,-1,-1,-1,-1,
10,1,2,9,5,0,5,3,0,5,7,3,-1,-1,-1,-1,
8,0,2,8,2,5,8,5,7,10,5,2,-1,-1,-1,-1,
2,10,5,2,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,
7,9,5,7,8,9,3,11,2,-1,-1,-1,-1,-1,-1,-1,
9,5,7,9,7,2,9,2,0,2,7,11,-1,-1,-1,-1,
2,3,11,0,1,8,1,7,8,1,5,7,-1,-1,-1,-1,
11,2,1,11,1,7,7,1,5,-1,-1,-1,-1,-1,-1,-1,
9,5,8,8,5,7,10,1,3,10,3,11,-1,-1,-1,-1,
5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1,
11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1,
11,10,5,7,11,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,0,1,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,8,3,1,9,8,5,10,6,-1,-1,-1,-1,-1,-1,-1,
1,6,5,2,6,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,6,5,1,2,6,3,0,8,-1,-1,-1,-1,-1,-1,-1,
9,6,5,9,0,6,0,2,6,-1,-1,-1,-1,-1,-1,-1,
5,9,8,5,8,2,5,2,6,3,2,8,-1,-1,-1,-1,
2,3,11,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,0,8,11,2,0,10,6,5,-1,-1,-1,-1,-1,-1,-1,
0,1,9,2,3,11,5,10,6,-1,-1,-1,-1,-1,-1,-1,
5,10,6,1,9,2,9,11,2,9,8,11,-1,-1,-1,-1,
6,3,11,6,5,3,5,1,3,-1,-1,-1,-1,-1,-1,-1,
0,8,11,0,11,5,0,5,1,5,11,6,-1,-1,-1,-1,
3,11,6,0,3,6,0,6,5,0,5,9,-1,-1,-1,-1,
6,5,9,6,9,11,11,9,8,-1,-1,-1,-1,-1,-1,-1,
5,10,6,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,3,0,4,7,3,6,5,10,-1,-1,-1,-1,-1,-1,-1,
1,9,0,5,10,6,8,4,7,-1,-1,-1,-1,-1,-1,-1,
10,6,5,1,9,7,1,7,3,7,9,4,-1,-1,-1,-1,
6,1,2,6,5,1,4,7,8,-1,-1,-1,-1,-1,-1,-1,
1,2,5,5,2,6,3,0,4,3,4,7,-1,-1,-1,-1,
8,4,7,9,0,5,0,6,5,0,2,6,-1,-1,-1,-1,
7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1,
3,11,2,7,8,4,10,6,5,-1,-1,-1,-1,-1,-1,-1,
5,10,6,4,7,2,4,2,0,2,7,11,-1,-1,-1,-1,
0,1,9,4,7,8,2,3,11,5,10,6,-1,-1,-1,-1,
9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1,
8,4,7,3,11,5,3,5,1,5,11,6,-1,-1,-1,-1,
5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1,
0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1,
6,5,9,6,9,11,4,7,9,7,11,9,-1,-1,-1,-1,
10,4,9,6,4,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,10,6,4,9,10,0,8,3,-1,-1,-1,-1,-1,-1,-1,
10,0,1,10,6,0,6,4,0,-1,-1,-1,-1,-1,-1,-1,
8,3,1,8,1,6,8,6,4,6,1,10,-1,-1,-1,-1,
1,4,9,1,2,4,2,6,4,-1,-1,-1,-1,-1,-1,-1,
3,0,8,1,2,9,2,4,9,2,6,4,-1,-1,-1,-1,
0,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,3,2,8,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,
10,4,9,10,6,4,11,2,3,-1,-1,-1,-1,-1,-1,-1,
0,8,2,2,8,11,4,9,10,4,10,6,-1,-1,-1,-1,
3,11,2,0,1,6,0,6,4,6,1,10,-1,-1,-1,-1,
6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1,
9,6,4,9,3,6,9,1,3,11,6,3,-1,-1,-1,-1,
8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1,
3,11,6,3,6,0,0,6,4,-1,-1,-1,-1,-1,-1,-1,
6,4,8,11,6,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,10,6,7,8,10,8,9,10,-1,-1,-1,-1,-1,-1,-1,
0,7,3,0,10,7,0,9,10,6,7,10,-1,-1,-1,-1,
10,6,7,1,10,7,1,7,8,1,8,0,-1,-1,-1,-1,
10,6,7,10,7,1,1,7,3,-1,-1,-1,-1,-1,-1,-1,
1,2,6,1,6,8,1,8,9,8,6,7,-1,-1,-1,-1,
2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1,
7,8,0,7,0,6,6,0,2,-1,-1,-1,-1,-1,-1,-1,
7,3,2,6,7,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,11,10,6,8,10,8,9,8,6,7,-1,-1,-1,-1,
2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1,
1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1,
11,2,1,11,1,7,10,6,1,6,7,1,-1,-1,-1,-1,
8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1,
0,9,1,11,6,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,8,0,7,0,6,3,11,0,11,6,0,-1,-1,-1,-1,
7,11,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,8,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,1,9,8,3,1,11,7,6,-1,-1,-1,-1,-1,-1,-1,
10,1,2,6,11,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,3,0,8,6,11,7,-1,-1,-1,-1,-1,-1,-1,
2,9,0,2,10,9,6,11,7,-1,-1,-1,-1,-1,-1,-1,
6,11,7,2,10,3,10,8,3,10,9,8,-1,-1,-1,-1,
7,2,3,6,2,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,0,8,7,6,0,6,2,0,-1,-1,-1,-1,-1,-1,-1,
2,7,6,2,3,7,0,1,9,-1,-1,-1,-1,-1,-1,-1,
1,6,2,1,8,6,1,9,8,8,7,6,-1,-1,-1,-1,
10,7,6,10,1,7,1,3,7,-1,-1,-1,-1,-1,-1,-1,
10,7,6,1,7,10,1,8,7,1,0,8,-1,-1,-1,-1,
0,3,7,0,7,10,0,10,9,6,10,7,-1,-1,-1,-1,
7,6,10,7,10,8,8,10,9,-1,-1,-1,-1,-1,-1,-1,
6,8,4,11,8,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,6,11,3,0,6,0,4,6,-1,-1,-1,-1,-1,-1,-1,
8,6,11,8,4,6,9,0,1,-1,-1,-1,-1,-1,-1,-1,
9,4,6,9,6,3,9,3,1,11,3,6,-1,-1,-1,-1,
6,8,4,6,11,8,2,10,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,3,0,11,0,6,11,0,4,6,-1,-1,-1,-1,
4,11,8,4,6,11,0,2,9,2,10,9,-1,-1,-1,-1,
10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1,
8,2,3,8,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,
0,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,9,0,2,3,4,2,4,6,4,3,8,-1,-1,-1,-1,
1,9,4,1,4,2,2,4,6,-1,-1,-1,-1,-1,-1,-1,
8,1,3,8,6,1,8,4,6,6,10,1,-1,-1,-1,-1,
10,1,0,10,0,6,6,0,4,-1,-1,-1,-1,-1,-1,-1,
4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1,
10,9,4,6,10,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,9,5,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,4,9,5,11,7,6,-1,-1,-1,-1,-1,-1,-1,
5,0,1,5,4,0,7,6,11,-1,-1,-1,-1,-1,-1,-1,
11,7,6,8,3,4,3,5,4,3,1,5,-1,-1,-1,-1,
9,5,4,10,1,2,7,6,11,-1,-1,-1,-1,-1,-1,-1,
6,11,7,1,2,10,0,8,3,4,9,5,-1,-1,-1,-1,
7,6,11,5,4,10,4,2,10,4,0,2,-1,-1,-1,-1,
3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1,
7,2,3,7,6,2,5,4,9,-1,-1,-1,-1,-1,-1,-1,
9,5,4,0,8,6,0,6,2,6,8,7,-1,-1,-1,-1,
3,6,2,3,7,6,1,5,0,5,4,0,-1,-1,-1,-1,
6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1,
9,5,4,10,1,6,1,7,6,1,3,7,-1,-1,-1,-1,
1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1,
4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1,
7,6,10,7,10,8,5,4,10,4,8,10,-1,-1,-1,-1,
6,9,5,6,11,9,11,8,9,-1,-1,-1,-1,-1,-1,-1,
3,6,11,0,6,3,0,5,6,0,9,5,-1,-1,-1,-1,
0,11,8,0,5,11,0,1,5,5,6,11,-1,-1,-1,-1,
6,11,3,6,3,5,5,3,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,9,5,11,9,11,8,11,5,6,-1,-1,-1,-1,
0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1,
11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1,
6,11,3,6,3,5,2,10,3,10,5,3,-1,-1,-1,-1,
5,8,9,5,2,8,5,6,2,3,8,2,-1,-1,-1,-1,
9,5,6,9,6,0,0,6,2,-1,-1,-1,-1,-1,-1,-1,
1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1,
1,5,6,2,1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1,
10,1,0,10,0,6,9,5,0,5,6,0,-1,-1,-1,-1,
0,3,8,5,6,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
10,5,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,5,10,7,5,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,5,10,11,7,5,8,3,0,-1,-1,-1,-1,-1,-1,-1,
5,11,7,5,10,11,1,9,0,-1,-1,-1,-1,-1,-1,-1,
10,7,5,10,11,7,9,8,1,8,3,1,-1,-1,-1,-1,
11,1,2,11,7,1,7,5,1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,1,2,7,1,7,5,7,2,11,-1,-1,-1,-1,
9,7,5,9,2,7,9,0,2,2,11,7,-1,-1,-1,-1,
7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1,
2,5,10,2,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,
8,2,0,8,5,2,8,7,5,10,2,5,-1,-1,-1,-1,
9,0,1,5,10,3,5,3,7,3,10,2,-1,-1,-1,-1,
9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1,
1,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,7,0,7,1,1,7,5,-1,-1,-1,-1,-1,-1,-1,
9,0,3,9,3,5,5,3,7,-1,-1,-1,-1,-1,-1,-1,
9,8,7,5,9,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
5,8,4,5,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,
5,0,4,5,11,0,5,10,11,11,3,0,-1,-1,-1,-1,
0,1,9,8,4,10,8,10,11,10,4,5,-1,-1,-1,-1,
10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1,
2,5,1,2,8,5,2,11,8,4,5,8,-1,-1,-1,-1,
0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1,
0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1,
9,4,5,2,11,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,5,10,3,5,2,3,4,5,3,8,4,-1,-1,-1,-1,
5,10,2,5,2,4,4,2,0,-1,-1,-1,-1,-1,-1,-1,
3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1,
5,10,2,5,2,4,1,9,2,9,4,2,-1,-1,-1,-1,
8,4,5,8,5,3,3,5,1,-1,-1,-1,-1,-1,-1,-1,
0,4,5,1,0,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,4,5,8,5,3,9,0,5,0,3,5,-1,-1,-1,-1,
9,4,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,11,7,4,9,11,9,10,11,-1,-1,-1,-1,-1,-1,-1,
0,8,3,4,9,7,9,11,7,9,10,11,-1,-1,-1,-1,
1,10,11,1,11,4,1,4,0,7,4,11,-1,-1,-1,-1,
3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1,
4,11,7,9,11,4,9,2,11,9,1,2,-1,-1,-1,-1,
9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1,
11,7,4,11,4,2,2,4,0,-1,-1,-1,-1,-1,-1,-1,
11,7,4,11,4,2,8,3,4,3,2,4,-1,-1,-1,-1,
2,9,10,2,7,9,2,3,7,7,4,9,-1,-1,-1,-1,
9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1,
3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1,
1,10,2,8,7,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,9,1,4,1,7,7,1,3,-1,-1,-1,-1,-1,-1,-1,
4,9,1,4,1,7,0,8,1,8,7,1,-1,-1,-1,-1,
4,0,3,7,4,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,8,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,9,3,9,11,11,9,10,-1,-1,-1,-1,-1,-1,-1,
0,1,10,0,10,8,8,10,11,-1,-1,-1,-1,-1,-1,-1,
3,1,10,11,3,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,11,1,11,9,9,11,8,-1,-1,-1,-1,-1,-1,-1,
3,0,9,3,9,11,1,2,9,2,11,9,-1,-1,-1,-1,
0,2,11,8,0,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,2,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,8,2,8,10,10,8,9,-1,-1,-1,-1,-1,-1,-1,
9,10,2,0,9,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,8,2,8,10,0,1,8,1,10,8,-1,-1,-1,-1,
1,10,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,3,8,9,1,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,9,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,3,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
]);

// Edge connections: which two corners each edge connects
// Edge i connects corner EDGE_CONN[i][0] and EDGE_CONN[i][1]
const EDGE_CONN = [
  [0, 1], [1, 2], [2, 3], [3, 0],   // bottom face (y=0)
  [4, 5], [5, 6], [6, 7], [7, 4],   // top face (y=1)
  [0, 4], [1, 5], [2, 6], [3, 7],   // vertical edges
];

// Corner offsets within a cube (8 corners)
const CORNER_OFFSET = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];

import { VoxelField, ExtractedMesh, TerrainType } from "./TerrainTypes";
import { TERRAIN_CONFIG } from "./TerrainConfig";

// Get terrain type at a surface point based on height and gradient
function getTerrainType(
  y: number,          // world-space y (unit space relative to island)
  gradientMag: number,// density gradient magnitude
  cliffNoise: number, // cliff placement noise value
): TerrainType {
  const cfg = TERRAIN_CONFIG;
  if (y < -cfg.depthHeight * 0.5) return TerrainType.DeepUnderwater;
  if (y < -cfg.depthHeight * 0.15) return TerrainType.ShallowUnderwater;
  if (y < 0) return TerrainType.Shoreline;
  if (y < cfg.beachThreshold) return TerrainType.Sand;
  // Cliff check: steep gradient or cliff noise zone
  if (gradientMag > cfg.cliffGradientThreshold || cliffNoise > cfg.cliffNoiseThreshold) {
    return TerrainType.Stone;
  }
  if (y < cfg.peakHeight * 0.4) return TerrainType.Grass;
  if (y < cfg.peakHeight * 0.7) return TerrainType.Forest;
  return TerrainType.Rock;
}

function terrainColor(type: TerrainType): [number, number, number] {
  const c = TERRAIN_CONFIG;
  switch (type) {
    case TerrainType.DeepUnderwater: return c.deepUnderwaterColor;
    case TerrainType.ShallowUnderwater: return c.shallowUnderwaterColor;
    case TerrainType.Shoreline: return c.shorelineColor;
    case TerrainType.Sand: return c.beachSandColor;
    case TerrainType.Grass: return c.grassColor;
    case TerrainType.Forest: return c.forestColor;
    case TerrainType.Stone: return c.cliffColor;
    case TerrainType.Rock: return c.rockColor;
    default: return c.grassColor;
  }
}

// Sample density at integer voxel coordinates with bounds check
function sampleDensity(field: VoxelField, x: number, y: number, z: number): number {
  if (x < 0 || x >= field.dimX || y < 0 || y >= field.dimY || z < 0 || z >= field.dimZ) {
    return -1.0; // outside = empty
  }
  return field.data[x * field.dimY * field.dimZ + y * field.dimZ + z];
}

// Compute density gradient via central differences at a point
function densityGradient(
  field: VoxelField, x: number, y: number, z: number,
): [number, number, number] {
  const dx = sampleDensity(field, x + 1, y, z) - sampleDensity(field, x - 1, y, z);
  const dy = sampleDensity(field, x, y + 1, z) - sampleDensity(field, x, y - 1, z);
  const dz = sampleDensity(field, x, y, z + 1) - sampleDensity(field, x, y, z - 1);
  return [dx * 0.5, dy * 0.5, dz * 0.5];
}

// Interpolate vertex position on an edge where the surface crosses
function interpolate(
  p1x: number, p1y: number, p1z: number, d1: number,
  p2x: number, p2y: number, p2z: number, d2: number,
  isoLevel: number,
): [number, number, number] {
  if (Math.abs(isoLevel - d1) < 1e-10) return [p1x, p1y, p1z];
  if (Math.abs(isoLevel - d2) < 1e-10) return [p2x, p2y, p2z];
  if (Math.abs(d1 - d2) < 1e-10) return [p1x, p1y, p1z];
  const t = (isoLevel - d1) / (d2 - d1);
  return [p1x + t * (p2x - p1x), p1y + t * (p2y - p1y), p1z + t * (p2z - p1z)];
}

// Preallocated scratch arrays for marching cubes (reused across extractMesh calls)
const SCRATCH_D = new Float32Array(8);
const SCRATCH_EDGE_VERTS = new Float32Array(12 * 3); // 12 edges × 3 coords
const SCRATCH_GRAD = new Float32Array(3);

// Growable typed array helper — doubles capacity when needed
function ensureCapacity(arr: Float32Array, needed: number): Float32Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Float32Array(newLen);
  newArr.set(arr);
  return newArr;
}

function ensureCapacityU32(arr: Uint32Array, needed: number): Uint32Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Uint32Array(newLen);
  newArr.set(arr);
  return newArr;
}

function ensureCapacityU16(arr: Uint16Array, needed: number): Uint16Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Uint16Array(newLen);
  newArr.set(arr);
  return newArr;
}

export function extractMesh(
  field: VoxelField,
  cliffNoiseFn?: (x: number, y: number, z: number) => number,
): ExtractedMesh {
  const iso = field.isoLevel;
  const vs = field.voxelSize;
  const dimYDimZ = field.dimY * field.dimZ;
  const dimZ = field.dimZ;
  const ox = field.originX, oy = field.originY, oz = field.originZ;

  // Growable typed arrays for output
  let verts: Float32Array = new Float32Array(65536);
  let vertCount = 0; // number of floats used
  let indices32: Uint32Array = new Uint32Array(32768);
  let indices16: Uint16Array = new Uint16Array(32768);
  let indexCount = 0;
  let useUint32 = false;

  const d = SCRATCH_D;
  const edgeVerts = SCRATCH_EDGE_VERTS;
  const grad = SCRATCH_GRAD;

  for (let x = 0; x < field.dimX - 1; x++) {
    for (let y = 0; y < field.dimY - 1; y++) {
      for (let z = 0; z < field.dimZ - 1; z++) {
        // Sample 8 corner densities using direct indexing (avoids function call overhead)
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const co = CORNER_OFFSET[c];
          const cx = x + co[0], cy = y + co[1], cz = z + co[2];
          let val: number;
          if (cx < 0 || cx >= field.dimX || cy < 0 || cy >= field.dimY || cz < 0 || cz >= field.dimZ) {
            val = -1.0;
          } else {
            val = field.data[cx * dimYDimZ + cy * dimZ + cz];
          }
          d[c] = val;
          if (val < iso) cubeIndex |= (1 << c);
        }

        const edges = EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        // Compute interpolated vertex positions for each crossed edge (inline, no tuples)
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const conn = EDGE_CONN[e];
          const c1 = conn[0], c2 = conn[1];
          const co1 = CORNER_OFFSET[c1];
          const co2 = CORNER_OFFSET[c2];

          const p1x = (x + co1[0]) * vs + ox, p1y = (y + co1[1]) * vs + oy, p1z = (z + co1[2]) * vs + oz;
          const p2x = (x + co2[0]) * vs + ox, p2y = (y + co2[1]) * vs + oy, p2z = (z + co2[2]) * vs + oz;
          const d1 = d[c1], d2 = d[c2];

          // Inline interpolation
          let ex: number, ey: number, ez: number;
          if (Math.abs(iso - d1) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else if (Math.abs(iso - d2) < 1e-10) {
            ex = p2x; ey = p2y; ez = p2z;
          } else if (Math.abs(d1 - d2) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else {
            const t = (iso - d1) / (d2 - d1);
            ex = p1x + t * (p2x - p1x);
            ey = p1y + t * (p2y - p1y);
            ez = p1z + t * (p2z - p1z);
          }
          const eo = e * 3;
          edgeVerts[eo] = ex;
          edgeVerts[eo + 1] = ey;
          edgeVerts[eo + 2] = ez;
        }

        // Generate triangles from flat TRI_TABLE
        const triBase = cubeIndex * 16;
        for (let t = 0; t < 15; t += 3) {
          const e0 = TRI_TABLE[triBase + t];
          if (e0 < 0) break;
          const e1 = TRI_TABLE[triBase + t + 1];
          const e2 = TRI_TABLE[triBase + t + 2];

          const ev0o = e0 * 3, ev1o = e1 * 3, ev2o = e2 * 3;
          const v0x = edgeVerts[ev0o], v0y = edgeVerts[ev0o + 1], v0z = edgeVerts[ev0o + 2];
          const v1x = edgeVerts[ev1o], v1y = edgeVerts[ev1o + 1], v1z = edgeVerts[ev1o + 2];
          const v2x = edgeVerts[ev2o], v2y = edgeVerts[ev2o + 1], v2z = edgeVerts[ev2o + 2];

          // Compute face normal (inline cross product)
          const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
          const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
          let nx = e1y * e2z - e1z * e2y;
          let ny = e1z * e2x - e1x * e2z;
          let nz = e1x * e2y - e1y * e2x;
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
          else { nx = 0; ny = 1; nz = 0; }
          if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

          // Determine terrain type at face centroid
          const cx = (v0x + v1x + v2x) / 3;
          const cy = (v0y + v1y + v2y) / 3;
          const cz = (v0z + v1z + v2z) / 3;
          const unitY = cy / field.radius;

          // Gradient magnitude at centroid (inline central differences)
          const gx = Math.round((cx - ox) / vs), gy = Math.round((cy - oy) / vs), gz = Math.round((cz - oz) / vs);
          let dxVal: number, dyVal: number, dzVal: number;
          // x-1 and x+1
          if (gx - 1 < 0 || gx - 1 >= field.dimX) dxVal = -1.0;
          else dxVal = field.data[(gx - 1) * dimYDimZ + gy * dimZ + gz];
          let dxP: number;
          if (gx + 1 < 0 || gx + 1 >= field.dimX) dxP = -1.0;
          else dxP = field.data[(gx + 1) * dimYDimZ + gy * dimZ + gz];
          grad[0] = (dxP - dxVal) * 0.5;
          // y-1 and y+1
          let dyM: number;
          if (gy - 1 < 0 || gy - 1 >= field.dimY) dyM = -1.0;
          else dyM = field.data[gx * dimYDimZ + (gy - 1) * dimZ + gz];
          let dyP: number;
          if (gy + 1 < 0 || gy + 1 >= field.dimY) dyP = -1.0;
          else dyP = field.data[gx * dimYDimZ + (gy + 1) * dimZ + gz];
          grad[1] = (dyP - dyM) * 0.5;
          // z-1 and z+1
          let dzM: number;
          if (gz - 1 < 0 || gz - 1 >= field.dimZ) dzM = -1.0;
          else dzM = field.data[gx * dimYDimZ + gy * dimZ + (gz - 1)];
          let dzP: number;
          if (gz + 1 < 0 || gz + 1 >= field.dimZ) dzP = -1.0;
          else dzP = field.data[gx * dimYDimZ + gy * dimZ + (gz + 1)];
          grad[2] = (dzP - dzM) * 0.5;
          const gradMag = Math.sqrt(grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2]);

          const cliffN = cliffNoiseFn ? cliffNoiseFn((cx - ox) / vs, (cy - oy) / vs, (cz - oz) / vs) : 0;
          const tType = getTerrainType(unitY, gradMag, cliffN);
          const col = terrainColor(tType);

          // Ensure capacity for 3 vertices (27 floats) and 3 indices
          if (vertCount + 27 > verts.length) {
            verts = ensureCapacity(verts, vertCount + 27);
          }
          // Write 3 vertices (9 floats each: pos3 + normal3 + color3)
          verts[vertCount++] = v0x; verts[vertCount++] = v0y; verts[vertCount++] = v0z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
          verts[vertCount++] = v1x; verts[vertCount++] = v1y; verts[vertCount++] = v1z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
          verts[vertCount++] = v2x; verts[vertCount++] = v2y; verts[vertCount++] = v2z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];

          const baseIdx = (vertCount - 27) / 9;

          // Switch to uint32 if needed — copy existing indices to the u32 array
          if (!useUint32 && baseIdx + 2 > 65535) {
            useUint32 = true;
            if (indexCount > indices32.length) {
              indices32 = ensureCapacityU32(indices32, indexCount);
            }
            for (let ci = 0; ci < indexCount; ci++) {
              indices32[ci] = indices16[ci];
            }
          }

          if (useUint32) {
            if (indexCount + 3 > indices32.length) {
              indices32 = ensureCapacityU32(indices32, indexCount + 3);
            }
            indices32[indexCount++] = baseIdx;
            indices32[indexCount++] = baseIdx + 1;
            indices32[indexCount++] = baseIdx + 2;
          } else {
            if (indexCount + 3 > indices16.length) {
              indices16 = ensureCapacityU16(indices16, indexCount + 3);
            }
            indices16[indexCount++] = baseIdx;
            indices16[indexCount++] = baseIdx + 1;
            indices16[indexCount++] = baseIdx + 2;
          }
        }
      }
    }
  }

  // Trim to actual used size
  const finalVerts = verts.subarray(0, vertCount);
  const finalIndices = useUint32
    ? indices32.subarray(0, indexCount)
    : indices16.subarray(0, indexCount);

  return {
    verts: finalVerts,
    indices: finalIndices as Uint16Array | Uint32Array,
    useUint32,
  };
}

// Extract mesh from a sub-region of a voxel field (for chunked streaming).
// Processes voxels from (x0,y0,z0) to (x1,y1,z1) inclusive.
// Vertex positions are in world space relative to the full field origin.
export function extractMeshSubRegion(
  field: VoxelField,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  cliffNoiseFn?: (x: number, y: number, z: number) => number,
): ExtractedMesh {
  const iso = field.isoLevel;
  const vs = field.voxelSize;
  const dimYDimZ = field.dimY * field.dimZ;
  const dimZ = field.dimZ;
  const ox = field.originX, oy = field.originY, oz = field.originZ;

  let verts: Float32Array = new Float32Array(65536);
  let vertCount = 0;
  let indices32: Uint32Array = new Uint32Array(32768);
  let indices16: Uint16Array = new Uint16Array(32768);
  let indexCount = 0;
  let useUint32 = false;

  const d = SCRATCH_D;
  const edgeVerts = SCRATCH_EDGE_VERTS;
  const grad = SCRATCH_GRAD;

  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const zStart = Math.max(0, z0);
  const xEnd = Math.min(field.dimX - 1, x1);
  const yEnd = Math.min(field.dimY - 1, y1);
  const zEnd = Math.min(field.dimZ - 1, z1);

  for (let x = xStart; x < xEnd; x++) {
    for (let y = yStart; y < yEnd; y++) {
      for (let z = zStart; z < zEnd; z++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const co = CORNER_OFFSET[c];
          const cx = x + co[0], cy = y + co[1], cz = z + co[2];
          let val: number;
          if (cx < 0 || cx >= field.dimX || cy < 0 || cy >= field.dimY || cz < 0 || cz >= field.dimZ) {
            val = -1.0;
          } else {
            val = field.data[cx * dimYDimZ + cy * dimZ + cz];
          }
          d[c] = val;
          if (val < iso) cubeIndex |= (1 << c);
        }

        const edges = EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const conn = EDGE_CONN[e];
          const c1 = conn[0], c2 = conn[1];
          const co1 = CORNER_OFFSET[c1];
          const co2 = CORNER_OFFSET[c2];

          const p1x = (x + co1[0]) * vs + ox, p1y = (y + co1[1]) * vs + oy, p1z = (z + co1[2]) * vs + oz;
          const p2x = (x + co2[0]) * vs + ox, p2y = (y + co2[1]) * vs + oy, p2z = (z + co2[2]) * vs + oz;
          const d1 = d[c1], d2 = d[c2];

          let ex: number, ey: number, ez: number;
          if (Math.abs(iso - d1) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else if (Math.abs(iso - d2) < 1e-10) {
            ex = p2x; ey = p2y; ez = p2z;
          } else if (Math.abs(d1 - d2) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else {
            const t = (iso - d1) / (d2 - d1);
            ex = p1x + t * (p2x - p1x);
            ey = p1y + t * (p2y - p1y);
            ez = p1z + t * (p2z - p1z);
          }
          const eo = e * 3;
          edgeVerts[eo] = ex;
          edgeVerts[eo + 1] = ey;
          edgeVerts[eo + 2] = ez;
        }

        const triBase = cubeIndex * 16;
        for (let t = 0; t < 15; t += 3) {
          const e0 = TRI_TABLE[triBase + t];
          if (e0 < 0) break;
          const e1 = TRI_TABLE[triBase + t + 1];
          const e2 = TRI_TABLE[triBase + t + 2];

          const ev0o = e0 * 3, ev1o = e1 * 3, ev2o = e2 * 3;
          const v0x = edgeVerts[ev0o], v0y = edgeVerts[ev0o + 1], v0z = edgeVerts[ev0o + 2];
          const v1x = edgeVerts[ev1o], v1y = edgeVerts[ev1o + 1], v1z = edgeVerts[ev1o + 2];
          const v2x = edgeVerts[ev2o], v2y = edgeVerts[ev2o + 1], v2z = edgeVerts[ev2o + 2];

          const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
          const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
          let nx = e1y * e2z - e1z * e2y;
          let ny = e1z * e2x - e1x * e2z;
          let nz = e1x * e2y - e1y * e2x;
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
          else { nx = 0; ny = 1; nz = 0; }
          if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

          const cx = (v0x + v1x + v2x) / 3;
          const cy = (v0y + v1y + v2y) / 3;
          const cz = (v0z + v1z + v2z) / 3;
          const unitY = cy / field.radius;

          const gx = Math.round((cx - ox) / vs), gy = Math.round((cy - oy) / vs), gz = Math.round((cz - oz) / vs);
          let dxVal: number;
          if (gx - 1 < 0 || gx - 1 >= field.dimX) dxVal = -1.0;
          else dxVal = field.data[(gx - 1) * dimYDimZ + gy * dimZ + gz];
          let dxP: number;
          if (gx + 1 < 0 || gx + 1 >= field.dimX) dxP = -1.0;
          else dxP = field.data[(gx + 1) * dimYDimZ + gy * dimZ + gz];
          grad[0] = (dxP - dxVal) * 0.5;
          let dyM: number;
          if (gy - 1 < 0 || gy - 1 >= field.dimY) dyM = -1.0;
          else dyM = field.data[gx * dimYDimZ + (gy - 1) * dimZ + gz];
          let dyP: number;
          if (gy + 1 < 0 || gy + 1 >= field.dimY) dyP = -1.0;
          else dyP = field.data[gx * dimYDimZ + (gy + 1) * dimZ + gz];
          grad[1] = (dyP - dyM) * 0.5;
          let dzM: number;
          if (gz - 1 < 0 || gz - 1 >= field.dimZ) dzM = -1.0;
          else dzM = field.data[gx * dimYDimZ + gy * dimZ + (gz - 1)];
          let dzP: number;
          if (gz + 1 < 0 || gz + 1 >= field.dimZ) dzP = -1.0;
          else dzP = field.data[gx * dimYDimZ + gy * dimZ + (gz + 1)];
          grad[2] = (dzP - dzM) * 0.5;
          const gradMag = Math.sqrt(grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2]);

          const cliffN = cliffNoiseFn ? cliffNoiseFn((cx - ox) / vs, (cy - oy) / vs, (cz - oz) / vs) : 0;
          const tType = getTerrainType(unitY, gradMag, cliffN);
          const col = terrainColor(tType);

          if (vertCount + 27 > verts.length) {
            verts = ensureCapacity(verts, vertCount + 27);
          }
          verts[vertCount++] = v0x; verts[vertCount++] = v0y; verts[vertCount++] = v0z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
          verts[vertCount++] = v1x; verts[vertCount++] = v1y; verts[vertCount++] = v1z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
          verts[vertCount++] = v2x; verts[vertCount++] = v2y; verts[vertCount++] = v2z;
          verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
          verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];

          const baseIdx = (vertCount - 27) / 9;

          if (!useUint32 && baseIdx + 2 > 65535) {
            useUint32 = true;
            if (indexCount > indices32.length) {
              indices32 = ensureCapacityU32(indices32, indexCount);
            }
            for (let ci = 0; ci < indexCount; ci++) {
              indices32[ci] = indices16[ci];
            }
          }

          if (useUint32) {
            if (indexCount + 3 > indices32.length) {
              indices32 = ensureCapacityU32(indices32, indexCount + 3);
            }
            indices32[indexCount++] = baseIdx;
            indices32[indexCount++] = baseIdx + 1;
            indices32[indexCount++] = baseIdx + 2;
          } else {
            if (indexCount + 3 > indices16.length) {
              indices16 = ensureCapacityU16(indices16, indexCount + 3);
            }
            indices16[indexCount++] = baseIdx;
            indices16[indexCount++] = baseIdx + 1;
            indices16[indexCount++] = baseIdx + 2;
          }
        }
      }
    }
  }

  const finalVerts = verts.subarray(0, vertCount);
  const finalIndices = useUint32
    ? indices32.subarray(0, indexCount)
    : indices16.subarray(0, indexCount);

  return {
    verts: finalVerts,
    indices: finalIndices as Uint16Array | Uint32Array,
    useUint32,
  };
}
