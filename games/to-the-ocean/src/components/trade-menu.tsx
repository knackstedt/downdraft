import React from "react";
import { useGameStore } from "../stores/game-store";

interface TradeItem {
  name: string;
  buyPrice: number;
  sellPrice: number;
  quantity: number;
}

export default function TradeMenu() {
  const toggle = useGameStore((s) => s.toggleTradeMenu);
  const [items] = React.useState<TradeItem[]>([
    { name: "Mackerel", buyPrice: 5, sellPrice: 4, quantity: 10 },
    { name: "Tuna", buyPrice: 20, sellPrice: 18, quantity: 5 },
    { name: "Wood", buyPrice: 3, sellPrice: 2, quantity: 50 },
    { name: "Rope", buyPrice: 8, sellPrice: 7, quantity: 20 },
    { name: "Metal Scrap", buyPrice: 15, sellPrice: 12, quantity: 10 },
    { name: "Basic Rod", buyPrice: 50, sellPrice: 40, quantity: 3 },
  ]);
  const [selectedItem, setSelectedItem] = React.useState<number>(-1);
  const [tradeQty, setTradeQty] = React.useState(1);

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto" onClick={toggle}>
      <div className="hud-panel p-6 max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-ocean-100 mb-4">Trading Post</h2>

        <div className="grid grid-cols-2 gap-4">
          {/* Item list */}
          <div>
            <h3 className="text-sm text-ocean-300 mb-2">Items</h3>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {items.map((item, i) => (
                <div
                  key={i}
                  className={`p-2 rounded cursor-pointer transition-colors ${
                    selectedItem === i ? "bg-ocean-600" : "bg-ocean-800/50 hover:bg-ocean-700/50"
                  }`}
                  onClick={() => setSelectedItem(i)}
                >
                  <div className="flex justify-between">
                    <span className="text-ocean-100">{item.name}</span>
                    <span className="text-ocean-400 text-sm">x{item.quantity}</span>
                  </div>
                  <div className="flex gap-4 text-xs text-ocean-400">
                    <span>Buy: {item.buyPrice}g</span>
                    <span>Sell: {item.sellPrice}g</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Trade panel */}
          <div>
            <h3 className="text-sm text-ocean-300 mb-2">Trade</h3>
            {selectedItem >= 0 ? (
              <div className="hud-panel p-4">
                <div className="text-ocean-100 font-bold mb-2">{items[selectedItem].name}</div>
                <div className="flex items-center gap-2 mb-4">
                  <button
                    className="btn-secondary px-3"
                    onClick={() => setTradeQty(Math.max(1, tradeQty - 1))}
                  >-</button>
                  <input
                    type="number"
                    className="input-field w-16 text-center"
                    value={tradeQty}
                    onChange={(e) => setTradeQty(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                  <button
                    className="btn-secondary px-3"
                    onClick={() => setTradeQty(tradeQty + 1)}
                  >+</button>
                </div>
                <div className="space-y-2">
                  <button className="btn-primary w-full">
                    Buy ({items[selectedItem].buyPrice * tradeQty}g)
                  </button>
                  <button className="btn-secondary w-full">
                    Sell ({items[selectedItem].sellPrice * tradeQty}g)
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-ocean-500 text-center py-8">Select an item to trade</div>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button className="btn-secondary" onClick={toggle}>Close [T]</button>
        </div>
      </div>
    </div>
  );
}
