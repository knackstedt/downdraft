import { useEffect, useState } from "react";
import type { VisitorOfferResult } from "../shared/types";
import { potionBaseValue } from "../simulation/bottling";
import { EFFECT_BY_ID } from "../simulation/effect-system";
import { evaluateOffer, generateVisitor, haggle } from "../simulation/visitors";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, left: 300, width: 400,
  background: "rgba(10,10,20,0.92)", borderRadius: 6, padding: 12,
  color: "#e8e8f0", fontFamily: "monospace", fontSize: 12,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "auto", maxHeight: "80vh", overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  color: "#c084fc", fontSize: 14, marginBottom: 8, borderBottom: "1px solid rgba(192,132,252,0.2)",
  paddingBottom: 4, display: "flex", justifyContent: "space-between",
};

const closeBtn: React.CSSProperties = {
  background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer",
  fontSize: 16, padding: 0,
};

const visitorCard: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", borderRadius: 6, padding: 10, marginBottom: 8,
  border: "1px solid rgba(255,255,255,0.1)",
};

const dialogLine: React.CSSProperties = {
  padding: "4px 0", color: "rgba(255,255,255,0.8)", fontStyle: "italic",
};

const potionOfferCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4,
  background: "rgba(255,255,255,0.05)", borderRadius: 4, border: "1px solid rgba(255,255,255,0.08)",
  cursor: "pointer",
};

const offerBtn: React.CSSProperties = {
  background: "rgba(34,197,94,0.2)", color: "#4ade80", fontSize: 11,
  padding: "4px 12px", borderRadius: 3, border: "1px solid rgba(34,197,94,0.3)",
  cursor: "pointer", fontFamily: "monospace",
};

const haggleBtn: React.CSSProperties = {
  background: "rgba(251,191,36,0.2)", color: "#fbbf24", fontSize: 11,
  padding: "4px 12px", borderRadius: 3, border: "1px solid rgba(251,191,36,0.3)",
  cursor: "pointer", fontFamily: "monospace",
};

const refuseBtn: React.CSSProperties = {
  background: "rgba(239,68,68,0.2)", color: "#f87171", fontSize: 11,
  padding: "4px 12px", borderRadius: 3, border: "1px solid rgba(239,68,68,0.3)",
  cursor: "pointer", fontFamily: "monospace",
};

const VISITOR_INTERVAL_MS = 90000; // 90 seconds between visitors

export function BoothPanel() {
  const { showBooth, activeVisitor, potions } = useGameStore();
  const setShowBooth = useGameStore((s) => s.setShowBooth);
  const setActiveVisitor = useGameStore((s) => s.setActiveVisitor);
  const removePotion = useGameStore((s) => s.removePotion);
  const addMoney = useGameStore((s) => s.addMoney);

  const [offerResult, setOfferResult] = useState<VisitorOfferResult | null>(null);
  const [currentPayout, setCurrentPayout] = useState(0);
  const [selectedPotionId, setSelectedPotionId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<string[]>([]);

  // Auto-arrive visitors when booth is open and no active visitor
  useEffect(() => {
    if (!showBooth || activeVisitor) return;
    const interval = setInterval(() => {
      const s = useGameStore.getState();
      if (!s.activeVisitor) {
        const v = generateVisitor();
        s.setActiveVisitor(v);
        setOfferResult(null);
        setCurrentPayout(0);
        setSelectedPotionId(null);
        setDialog(v.requestFlavor);
      }
    }, VISITOR_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [showBooth, activeVisitor]);

  // Patience countdown
  useEffect(() => {
    if (!activeVisitor) return;
    const interval = setInterval(() => {
      const elapsed = (Date.now() - activeVisitor.arrivedAt) / 1000;
      if (elapsed > activeVisitor.patienceSec) {
        setDialog(["...I've waited long enough. Goodbye."]);
        setTimeout(() => {
          setActiveVisitor(null);
          setOfferResult(null);
          setCurrentPayout(0);
          setSelectedPotionId(null);
        }, 2000);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activeVisitor, setActiveVisitor]);

  if (!showBooth) return null;

  function offerPotion(potionId: string) {
    if (!activeVisitor) return;
    const potion = potions.find((p) => p.id === potionId);
    if (!potion) return;
    setSelectedPotionId(potionId);
    const result = evaluateOffer(potion, activeVisitor);
    setOfferResult(result);
    setCurrentPayout(result.finalPayout);
    setDialog(result.responseLines);
  }

  function doHaggle() {
    if (!activeVisitor || !offerResult || currentPayout <= 0) return;
    const raisePercent = 20;
    const result = haggle(activeVisitor, currentPayout, raisePercent);
    setCurrentPayout(result.newPayout);
    setDialog(result.responseLines);
    if (!result.accepted) {
      // Visitor leaves in 2 seconds
      setTimeout(() => {
        setActiveVisitor(null);
        setOfferResult(null);
        setCurrentPayout(0);
        setSelectedPotionId(null);
      }, 2000);
    } else {
      // Update offer result with new payout
      setOfferResult({ ...offerResult, finalPayout: result.newPayout });
    }
  }

  function acceptOffer() {
    if (!offerResult || !selectedPotionId || !activeVisitor) return;
    addMoney(currentPayout);
    removePotion(selectedPotionId);
    setDialog([`Pleasure doing business. ${currentPayout} gold, as agreed.`]);
    setTimeout(() => {
      setActiveVisitor(null);
      setOfferResult(null);
      setCurrentPayout(0);
      setSelectedPotionId(null);
    }, 1500);
  }

  function refuse() {
    setDialog(["No deal. I'll take my gold elsewhere."]);
    setTimeout(() => {
      setActiveVisitor(null);
      setOfferResult(null);
      setCurrentPayout(0);
      setSelectedPotionId(null);
    }, 1500);
  }

  function summonVisitor() {
    const v = generateVisitor();
    setActiveVisitor(v);
    setOfferResult(null);
    setCurrentPayout(0);
    setSelectedPotionId(null);
    setDialog(v.requestFlavor);
  }

  const elapsed = activeVisitor ? (Date.now() - activeVisitor.arrivedAt) / 1000 : 0;
  const patienceLeft = activeVisitor ? Math.max(0, activeVisitor.patienceSec - elapsed) : 0;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Visitor Booth</span>
        <button style={closeBtn} onClick={() => setShowBooth(false)}>✕</button>
      </div>

      {!activeVisitor ? (
        <div style={{ textAlign: "center", padding: 20 }}>
          <div style={{ color: "rgba(255,255,255,0.4)", marginBottom: 12 }}>
            No visitors right now. They arrive every ~90 seconds.
          </div>
          <button style={offerBtn} onClick={summonVisitor}>Summon a visitor</button>
        </div>
      ) : (
        <>
          <div style={visitorCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 28 }}>{activeVisitor.face}</span>
              <div>
                <strong>{activeVisitor.name}</strong>
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>
                  Budget: ~${Math.round(activeVisitor.budget)} | Mood: {(activeVisitor.mood * 100).toFixed(0)}% | Patience: {patienceLeft.toFixed(0)}s
                </div>
              </div>
            </div>
            <div style={{ color: "rgba(192,132,252,0.6)", fontSize: 10, marginBottom: 6 }}>
              Wants: {activeVisitor.desiredEffects.length > 0
                ? activeVisitor.desiredEffects.map((id) => EFFECT_BY_ID[id]?.name ?? id).join(", ")
                : "Anything impressive"}
            </div>
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 6 }}>
              {dialog.map((line, i) => (
                <div key={i} style={dialogLine}>"{line}"</div>
              ))}
            </div>
          </div>

          {offerResult && offerResult.accepted && (
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button style={offerBtn} onClick={acceptOffer}>
                Accept ${currentPayout}
              </button>
              <button style={haggleBtn} onClick={doHaggle}>
                Haggle +20%
              </button>
              <button style={refuseBtn} onClick={refuse}>Refuse</button>
            </div>
          )}

          <div style={{ color: "#c084fc", fontSize: 11, margin: "8px 0 4px", textTransform: "uppercase", letterSpacing: 1 }}>
            Offer a potion:
          </div>
          {potions.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.4)" }}>No potions to offer — brew some first</div>
          ) : (
            potions.map((p) => {
              const colorCss = `rgb(${Math.round(p.color[0] * 255)},${Math.round(p.color[1] * 255)},${Math.round(p.color[2] * 255)})`;
              const value = potionBaseValue(p);
              return (
                <div
                  key={p.id}
                  style={{ ...potionOfferCard, ...(selectedPotionId === p.id ? { border: "1px solid #c084fc" } : {}) }}
                  onClick={() => offerPotion(p.id)}
                >
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: colorCss, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>~${value}</span>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
