#ifndef SRC_NODE_MOBILE_VERSION_H_
#define SRC_NODE_MOBILE_VERSION_H_

#include "node_version.h"

// Tracks the upstream Node version this mobile build is based on
// (packages/node-mobile/node-version.txt) plus our rebuild revision.
#define NODE_MOBILE_MAJOR_VERSION 26
#define NODE_MOBILE_MINOR_VERSION 10
#define NODE_MOBILE_PATCH_VERSION 0

// Rebuild revision of the same upstream Node version. Bump when the patch
// series or overlay changes without an upstream version bump.
#define NODE_MOBILE_REVISION 0

#define NODE_MOBILE_VERSION_IS_RELEASE NODE_VERSION_IS_RELEASE

#if NODE_MOBILE_VERSION_IS_RELEASE
#define NODE_MOBILE_TAG ""
#else
#define NODE_MOBILE_TAG "-pre"
#endif

#define NODE_MOBILE_VERSION_STRING                                                                                                     \
  NODE_STRINGIFY(NODE_MOBILE_MAJOR_VERSION)                                                                                            \
  "." NODE_STRINGIFY(NODE_MOBILE_MINOR_VERSION) "." NODE_STRINGIFY(NODE_MOBILE_PATCH_VERSION) "-" NODE_STRINGIFY(NODE_MOBILE_REVISION) \
      NODE_MOBILE_TAG

#endif // SRC_NODE_MOBILE_VERSION_H_
