import { Container } from "pixi.js";
import { makeLabel } from "../shared/widgets";
import { COLOR_TEXT_DIM } from "../shared/colors";
import type { DebuggerScene } from "../debugger-scene";

export function renderPerfRecorderPanel(_scene: DebuggerScene, x: number, y: number, _w: number, _h: number): Container {
  const c = new Container();
  c.x = x; c.y = y;
  c.addChild(makeLabel("Performance Recorder — CDP Profiler + flame graph (checkpoint 8)", 10, 10, COLOR_TEXT_DIM));
  return c;
}
