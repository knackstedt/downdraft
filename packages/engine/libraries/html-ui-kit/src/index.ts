// ============================================================================
// html-ui-kit — themed widget kit for the Blitz html-ui stack.
//
//   import * as kit from "@downdraft/engine/libraries/html-ui-kit";
//   const handle = host.mount({ rect, html: `<html><head>${kit.kitStyleTag()}</head>
//     <body>${kit.button({ label: "Go" })}${kit.slider({ id: "vol", value: 50 })}…` });
//   const kb = kit.bindKit(handle, { onChange: (id, kind, v) => … });
// ============================================================================

export { bindKit } from "./behaviors";
export type { KitBinding, KitDelegate } from "./behaviors";
export {
    accordion, badge, button, checkbox, col, contextMenu, dataAttrs, dataTable, divider, dropdown, esc, fieldError, kvTable, label, listView, menu, modal, numberField, panel, progressBar, radioGroup, row, scrollView, sectionLabel, segmented, slider, spacer, spinner, switchToggle, tabs, textArea, textInput, toastStack,
    toolbar, tooltipWrap, treeView
} from "./components";
export type { AccordionSection, ButtonOpts, DropdownOpts, InputOpts, ListOpts, MenuItem, NumberFieldOpts, RadioOpts, SegmentedOpts, SliderOpts, TableOpts, TabsOpts, Toast, ToastKind, ToggleOpts, TreeNode } from "./components";
export { NavController } from "./nav/nav-controller";
export type { NavAction, NavControllerOptions, NavDirection } from "./nav/nav-controller";
export { keyToNavAction, PadNavDriver } from "./nav/nav-input";
export type { NavInputOptions } from "./nav/nav-input";
export { openOsk } from "./nav/osk";
export type { OskOptions, OskSession } from "./nav/osk";
export { PadCursorDriver, VirtualCursor } from "./nav/vcursor";
export type { PadCursorOptions, VirtualCursorOptions } from "./nav/vcursor";
export { KIT_CSS, KIT_FONT_FAMILY, kitStyleTag } from "./theme";

