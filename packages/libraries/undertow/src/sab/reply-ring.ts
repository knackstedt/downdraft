// ============================================================================
// reply-ring — main → worker reply ring. Main is producer, worker is consumer.
// ============================================================================

import { REPLY_RECORD_BYTES } from "../shared/protocol";
import type { DomSabRegions } from "./dom-sab";
import { RingView } from "./ring";

export class ReplyRing extends RingView {
  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    super(sab, regions.replyOffset, regions.replyBytes, REPLY_RECORD_BYTES);
  }
}
