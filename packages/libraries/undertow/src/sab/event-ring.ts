// ============================================================================
// event-ring — main → worker event ring. Main is the sole producer (MPSC
// where "M" = multiple real DOM listeners on the main thread, all funneling
// into this one ring), worker is the consumer. Records carry a payload ref
// into the PAYLOAD_HEAP for the structured-clone-lite event blob.
// ============================================================================

import { EVENT_RECORD_BYTES } from "../shared/protocol";
import type { DomSabRegions } from "./dom-sab";
import { RingView } from "./ring";

export class EventRing extends RingView {
  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    super(sab, regions.eventOffset, regions.eventBytes, EVENT_RECORD_BYTES);
  }
}
