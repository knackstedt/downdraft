// ============================================================================
// request-ring — worker → main op-request ring. Thin specialization of RingView
// over the REQUEST_RING region of the dom-sab. Worker is producer, main is consumer.
// ============================================================================

import { OP_RECORD_BYTES } from "../shared/protocol";
import type { DomSabRegions } from "./dom-sab";
import { RingView } from "./ring";

export class RequestRing extends RingView {
  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    super(sab, regions.reqOffset, regions.reqBytes, OP_RECORD_BYTES);
  }
}
