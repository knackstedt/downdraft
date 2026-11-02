//! Geometric damage tracking for the OSR raster path.
//!
//! The raster used to repaint the full frame every dirty tick and byte-diff
//! it against the retained frame to derive the upload rect — O(tree) scene
//! build + O(frame) shade + O(frame) memcmp per dirty frame. This module
//! predicts the changed region from DOM state instead:
//!
//!  - Pre-resolve, every node carrying stylo `RestyleDamage` or a pending
//!    pseudo-state snapshot (`has_snapshot` — hover/focus/active/checked
//!    transitions queue a restyle) contributes its paint envelope.
//!  - Post-resolve, a per-node geometry snapshot (border box, scrollable
//!    overflow, scroll offset, transform) diffs against the previous
//!    frame's — moved, resized, appeared, removed and scrolled nodes
//!    contribute their old-∪-new envelopes. This also catches damage that
//!    never set a stylo flag (e.g. mutations that only shift geometry).
//!  - Anything that can repaint pixels far from the damaged node is a
//!    conservative full-frame fallback: CSS transforms (2D affine can fling
//!    content anywhere), running CSS animations/transitions, `filter`
//!    regions, `<canvas>`/replaced content changes, text-selection paint,
//!    and viewport scroll.
//!
//! The predicted rect bounds a clip-layer raster (vello_cpu only shades
//! inside the clip) plus a scoped verify-diff, so raster+diff cost scales
//! with damage rather than frame size. A periodic full-frame diff pass
//! (`DD_OSR_DAMAGE_CHECK_EVERY`, default every 600 rasters) still compares
//! the entire frame and heals any region the predictor missed —
//! misprediction can only cause transient artifacts, never sticky ones.
//! `DD_OSR_DAMAGE=full` restores the old always-full behavior.

use std::collections::HashMap;
use std::sync::OnceLock;

use blitz_dom::{BaseDocument, NodeId};

/// AA fringe + paint bleed safety margin, CSS px. Kept small — the verify
/// diff and heal check catch residuals.
const BASE_BLEED: f64 = 3.0;

#[derive(Clone, Copy)]
enum DamageMode {
    /// Predict regions; run a full-frame validate+heal diff every N
    /// rasters (0 disables validation — fastest, artifacts could stick
    /// until the next full repaint).
    Region { check_every: u32 },
    /// Always full raster + full diff — the pre-damage behavior.
    Full,
}

fn damage_mode() -> DamageMode {
    static MODE: OnceLock<DamageMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        let v = std::env::var("DD_OSR_DAMAGE").unwrap_or_default();
        if v == "full" || v == "0" {
            return DamageMode::Full;
        }
        let every = std::env::var("DD_OSR_DAMAGE_CHECK_EVERY")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(600);
        DamageMode::Region {
            check_every: every,
        }
    })
}

/// Per-node paint envelope + the state that changes where it paints.
#[derive(Clone, Copy)]
struct GeomSnap {
    /// Border box, document CSS px.
    border: [f64; 4],
    /// Border ∪ scrollable overflow, inflated by paint bleed, CSS px.
    env: [f64; 4],
    /// Scroll offset — a change repaints the scrollport.
    scroll: [f64; 2],
    /// Identity of the node's primary `ComputedValues` allocation — stylo
    /// replaces the Arc on every restyle (the transient damage flags are
    /// cleared by resolve() before we can read them, but a swapped style
    /// pointer is a durable post-resolve signal that the node's paint may
    /// have changed).
    style_ptr: usize,
    /// True when this node or a layout ancestor carries a 2D transform —
    /// paint position is then unbounded by the envelope.
    transformed: bool,
    /// Node has a canvas/sub-doc payload whose pixels can change without
    /// geometry or style flags.
    volatile: bool,
    /// Fingerprint of the node's raster payloads (`<img>` special data and
    /// background/mask image layers: status + payload pointer). Blitz sets
    /// a loaded `background-image` layer's pixels with NO damage flag and
    /// no restyle — `request_redraw` alone — so this is the only signal
    /// that catches the arrival.
    img_state: u64,
}

/// Rect accumulator in document CSS px.
#[derive(Default, Clone, Copy)]
struct Union {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    empty: bool,
}

impl Union {
    fn none() -> Self {
        Union {
            x0: f64::INFINITY,
            y0: f64::INFINITY,
            x1: f64::NEG_INFINITY,
            y1: f64::NEG_INFINITY,
            empty: true,
        }
    }
    fn add(&mut self, r: [f64; 4]) {
        self.x0 = self.x0.min(r[0]);
        self.y0 = self.y0.min(r[1]);
        self.x1 = self.x1.max(r[0] + r[2]);
        self.y1 = self.y1.max(r[1] + r[3]);
        self.empty = false;
    }
    fn rect(&self) -> Option<[f64; 4]> {
        if self.empty || self.x1 <= self.x0 || self.y1 <= self.y0 {
            None
        } else {
            Some([self.x0, self.y0, self.x1 - self.x0, self.y1 - self.y0])
        }
    }
}

/// Outcome of one damage computation.
pub enum Damage {
    /// Nothing repaints — skip raster entirely.
    None,
    /// Repaint clipped to this document-space CSS-px rect.
    Region([f64; 4]),
    /// Repaint the whole viewport.
    Full,
}

pub struct DamageTracker {
    /// Node paint envelopes from the last rastered frame. Empty ⇒ full
    /// (first frame, rebuild, resize).
    geom: HashMap<u64, GeomSnap>,
    /// Damage/snapshot-carrying node ids collected pre-resolve.
    flagged: Vec<(u64, bool)>,
    /// Whether the last frame ran with an active text selection.
    had_selection: bool,
    /// Viewport scroll at the last raster.
    vp_scroll: [f64; 2],
    /// Rasters since the last full validation pass.
    since_check: u32,
}

/// Paint bleed beyond the border box contributed by the node's own style:
/// box-shadow extent, outline width (+offset slack), filter region.
fn style_bleed(node: &blitz_dom::Node) -> f64 {
    let Some(styles) = node.primary_styles() else {
        return 0.0;
    };
    let effects = styles.get_effects();
    let mut bleed = 0.0f64;
    for s in effects.box_shadow.0.iter() {
        if s.inset {
            continue;
        }
        let ext = s.spread.px() as f64
            + s.base.blur.px() as f64 * 2.5
            + (s.base.horizontal.px().abs() + s.base.vertical.px().abs()) as f64;
        bleed = bleed.max(ext);
    }
    let ow = styles.get_outline().outline_width.0.to_f64_px();
    if ow > 0.0 {
        // +8 slack for outline-offset.
        bleed = bleed.max(ow + 8.0);
    }
    use style::computed_values::filter::single_value::T as StyloFilter;
    for f in effects.filter.0.iter() {
        bleed = bleed.max(match f {
            StyloFilter::Blur(r) => r.px() as f64 * 2.5,
            StyloFilter::DropShadow(sh) => {
                sh.blur.px() as f64 * 2.5
                    + (sh.horizontal.px().abs() + sh.vertical.px().abs()) as f64
            }
            _ => continue,
        });
    }
    bleed
}

/// True when the node paints through a 2D transform (own or any layout
/// ancestor's — transformed pixels can land far outside the envelope).
fn under_transform(doc: &BaseDocument, id: NodeId) -> bool {
    let mut cur = Some(id);
    let mut hops = 0u32;
    while let Some(nid) = cur {
        let Some(n) = doc.get_node(nid) else {
            return true;
        };
        if n.transform().is_some() {
            return true;
        }
        if hops > 128 {
            return true;
        }
        hops += 1;
        cur = n.layout_parent.get().or(n.parent);
    }
    false
}

/// True when the node can repaint without any signal we track. Text
/// inputs are the big one: every keystroke/IME edit lands in the parley
/// editor and fires `request_redraw` with NO stylo damage (see
/// `apply_generated_text_input_event` in blitz-dom) — no restyle, no
/// geometry change. Canvas/sub-doc/custom-widget payloads repaint out of
/// band the same way.
fn is_volatile(node: &blitz_dom::Node) -> bool {
    node.element_data()
        .map(|el| {
            el.canvas_data().is_some()
                || el.sub_doc_data().is_some()
                || el.text_input_data().is_some()
        })
        .unwrap_or(false)
}

/// Fingerprint the node's raster payloads — `<img>` special data plus
/// background/mask layer images. A layer's `Status` flips Loading→Ok when
/// bytes arrive without any stylo damage, so the status+payload-pointer
/// hash is the damage signal. (Raster payload ptr: Blob's data address —
/// Arc-stable across clones.)
fn img_state_fp(node: &blitz_dom::Node) -> u64 {
    use blitz_dom::node::{ImageData, SpecialElementData};
    let Some(el) = node.element_data() else {
        return 0;
    };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut fold = |disc: u64, ptr: u64| {
        h = (h ^ disc).wrapping_mul(0x1000_0000_01b3);
        h = (h ^ ptr).wrapping_mul(0x1000_0000_01b3);
    };
    let image_fp = |img: &ImageData, fold: &mut dyn FnMut(u64, u64)| match img {
        ImageData::Raster(r) => fold(1, r.data.id()),
        ImageData::None => fold(0, 0),
        #[allow(unreachable_patterns)]
        _ => fold(2, img as *const ImageData as u64),
    };
    if let SpecialElementData::Image(img) = &el.special_data {
        image_fp(img, &mut fold);
    }
    for layer in el
        .background_images
        .iter()
        .chain(el.mask_images.iter())
        .flatten()
    {
        fold(3, layer.status.clone() as u64);
        image_fp(&layer.image, &mut fold);
    }
    h
}

/// The node's paint envelope: border box ∪ scrollable overflow (covers
/// overflowing children and inline text that has no layout node of its
/// own), inflated by paint bleed. All in document CSS px.
fn snap_node(
    doc: &BaseDocument,
    id: NodeId,
    node: &blitz_dom::Node,
    scale: f64,
) -> Option<GeomSnap> {
    use blitz_dom::NodeData;
    if !matches!(
        node.data,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) | NodeData::Document(_)
    ) {
        return None;
    }
    if node.taffy_display() == taffy::Display::None {
        return None;
    }
    let p = node.unrounded_absolute_position(0.0, 0.0);
    let so = node.scroll_offset();
    // unrounded_absolute_position subtracts this node's own scroll offset
    // (it yields the scrolled-content origin); add it back for the border box.
    let bx = p.x as f64 + so.x;
    let by = p.y as f64 + so.y;
    let size = node.final_layout().size;
    let border = [bx, by, size.width as f64, size.height as f64];

    // scrollable_overflow is device px in the node's border-box space.
    let ovf = node.scrollable_overflow();
    let mut u = Union::none();
    u.add(border);
    u.add([
        bx + ovf.x0 / scale,
        by + ovf.y0 / scale,
        (ovf.x1 - ovf.x0) / scale,
        (ovf.y1 - ovf.y0) / scale,
    ]);
    let b = BASE_BLEED + style_bleed(node);
    let mut env = u.rect().unwrap_or(border);
    env[0] -= b;
    env[1] -= b;
    env[2] += 2.0 * b;
    env[3] += 2.0 * b;

    let style_ptr = node
        .primary_styles()
        .map(|s| s.raw_ptr().as_ptr() as usize)
        .unwrap_or(0);

    let _ = doc;
    let _ = id;
    Some(GeomSnap {
        border,
        env,
        scroll: [so.x, so.y],
        style_ptr,
        transformed: false, // filled by caller (needs ancestor state)
        volatile: is_volatile(node),
        img_state: img_state_fp(node),
    })
}

impl DamageTracker {
    pub fn new() -> Self {
        DamageTracker {
            geom: HashMap::new(),
            flagged: Vec::new(),
            had_selection: false,
            vp_scroll: [f64::NAN, f64::NAN],
            since_check: 0,
        }
    }

    /// Forget all snapshots — next raster is a full repaint. Call on
    /// document rebuild, resize, renderer reset.
    pub fn reset(&mut self) {
        self.geom.clear();
        self.flagged.clear();
        self.since_check = 0;
    }

    /// Pre-resolve pass: collect nodes carrying stylo damage flags or a
    /// pending pseudo-state snapshot. Cheap — one DOM walk, no layout data
    /// touched. Resolve clears the flags, so they must be read first.
    pub fn collect_pre_resolve(&mut self, doc: &BaseDocument) {
        self.flagged.clear();
        if let DamageMode::Full = damage_mode() {
            return;
        }
        doc.visit(|id, n| {
            let dmg = n.damage().map(|d| d.bits()).unwrap_or(0);
            let snap = n.has_snapshot();
            if dmg != 0 || snap {
                // snap ⇒ restyle can reach siblings/ancestors — mark it so
                // post-resolve widens the envelope to the parent chain.
                self.flagged.push((id.as_u64(), snap));
            }
        });
    }

    /// Post-resolve pass: diff node geometry against the stored snapshot
    /// and fold in the pre-resolve flags. Returns the damage region in
    /// document CSS px. Always refreshes the snapshot so the next frame
    /// has a valid baseline.
    pub fn compute(&mut self, doc: &BaseDocument) -> Damage {
        if let DamageMode::Full = damage_mode() {
            return Damage::Full;
        }

        let scale = doc.viewport().scale_f64();
        let vps = doc.viewport_scroll();
        let sel = doc.has_text_selection();

        // Full-frame fallbacks.
        let mut full = self.geom.is_empty()
            || doc.is_animating()
            || sel
            || self.had_selection
            || self.vp_scroll[0] != vps.x
            || self.vp_scroll[1] != vps.y;
        self.had_selection = sel;
        self.vp_scroll = [vps.x, vps.y];

        // Periodic validation: force a full raster + full diff to heal
        // anything the predictor missed.
        if let DamageMode::Region { check_every } = damage_mode() {
            self.since_check += 1;
            if check_every > 0 && self.since_check >= check_every {
                self.since_check = 0;
                full = true;
            }
        }

        if full {
            self.snapshot(doc);
            return Damage::Full;
        }

        // Walk the tree once: rebuild the snapshot, diff against the old
        // one, union changed envelopes.
        let mut new_geom: HashMap<u64, GeomSnap> = HashMap::with_capacity(self.geom.len());
        let mut u = Union::none();
        doc.visit(|id, n| {
            let Some(mut s) = snap_node(doc, id, n, scale) else {
                return;
            };
            let raw = id.as_u64();
            s.transformed = n.transform().is_some()
                || n.layout_parent
                    .get()
                    .or(n.parent)
                    .and_then(|p| new_geom.get(&p.as_u64()))
                    .map(|ps| ps.transformed)
                    .unwrap_or_else(|| under_transform(doc, id));
            match self.geom.get(&raw) {
                Some(old) => {
                    let moved = old.border != s.border || old.env != s.env;
                    let scrolled = old.scroll != s.scroll;
                    // A swapped ComputedValues allocation ⇒ the node was
                    // restyled — its paint may differ even when geometry
                    // doesn't (colors, shadows, visibility, images).
                    // A raster payload flip (async image load landing in a
                    // layer/special-data slot) repaints without any flag.
                    let restyled =
                        old.style_ptr != s.style_ptr || old.img_state != s.img_state;
                    if (moved || scrolled || restyled)
                        && (s.transformed || old.transformed)
                    {
                        // Transformed paint can land anywhere.
                        u.add([0.0, 0.0, f64::MAX / 4.0, f64::MAX / 4.0]);
                        return;
                    }
                    if moved || restyled {
                        u.add(old.env);
                        u.add(s.env);
                    }
                    if scrolled {
                        // Only the scrollport repaints.
                        u.add(old.border);
                        u.add(s.border);
                    }
                }
                None => {
                    if s.transformed {
                        u.add([0.0, 0.0, f64::MAX / 4.0, f64::MAX / 4.0]);
                        return;
                    }
                    u.add(s.env);
                }
            }
            if s.volatile {
                // Replaced content may repaint every frame.
                u.add(s.env);
            }
            new_geom.insert(raw, s);
        });

        // Removed nodes: their old envelopes repaint.
        for (id, old) in self.geom.iter() {
            if !new_geom.contains_key(id) {
                if old.transformed {
                    u.add([0.0, 0.0, f64::MAX / 4.0, f64::MAX / 4.0]);
                } else {
                    u.add(old.env);
                }
            }
        }

        // Pre-resolve flagged nodes: own envelope old∪new; snapshot nodes
        // additionally union the parent chain (sibling/ancestor restyles).
        let flagged = std::mem::take(&mut self.flagged);
        for (raw, snap) in flagged {
            if u.rect().map_or(false, |r| r[2] >= f64::MAX / 8.0) {
                break; // already full
            }
            let id = NodeId::from_u64(raw);
            if under_transform(doc, id) {
                u.add([0.0, 0.0, f64::MAX / 4.0, f64::MAX / 4.0]);
                break;
            }
            if let Some(s) = new_geom.get(&raw) {
                u.add(s.env);
            }
            if let Some(s) = self.geom.get(&raw) {
                u.add(s.env);
            }
            if snap {
                // Pseudo-state restyle can paint siblings and ancestors
                // (e.g. :hover on ancestors) — union the ancestor chain's
                // envelopes plus the parent's subtree bound (parent env
                // already spans its scrollable overflow).
                let mut cur = doc.get_node(id).and_then(|n| n.parent);
                let mut hops = 0u32;
                while let Some(pid) = cur {
                    if let Some(s) = new_geom.get(&pid.as_u64()) {
                        u.add(s.env);
                    }
                    hops += 1;
                    if hops > 64 {
                        break;
                    }
                    cur = doc.get_node(pid).and_then(|n| n.parent);
                }
            }
        }

        self.geom = new_geom;
        match u.rect() {
            None => Damage::None,
            Some(r) if r[2] >= f64::MAX / 8.0 => Damage::Full,
            Some(r) => Damage::Region(r),
        }
    }

    /// Rebuild the geometry snapshot without computing a diff.
    fn snapshot(&mut self, doc: &BaseDocument) {
        self.flagged.clear();
        let scale = doc.viewport().scale_f64();
        let mut g: HashMap<u64, GeomSnap> = HashMap::with_capacity(self.geom.len().max(64));
        doc.visit(|id, n| {
            if let Some(mut s) = snap_node(doc, id, n, scale) {
                s.transformed = n.transform().is_some()
                    || n.layout_parent
                        .get()
                        .or(n.parent)
                        .and_then(|p| g.get(&p.as_u64()))
                        .map(|ps| ps.transformed)
                        .unwrap_or_else(|| under_transform(doc, id));
                g.insert(id.as_u64(), s);
            }
        });
        self.geom = g;
    }
}


