// ============================================================================
// html-ui-kit — themed widget kit for the Blitz html-ui stack.
//
//   import * as kit from "@downdraft/engine/libraries/html-ui-kit";
//   const handle = host.mount({ rect, html: `<html><head>${kit.kitStyleTag()}</head>
//     <body>${kit.button({ label: "Go" })}${kit.slider({ id: "vol", value: 50 })}…` });
//   const kb = kit.bindKit(handle, { onChange: (id, kind, v) => … });
// ============================================================================

export { KIT_CSS, KIT_FONT_FAMILY, kitStyleTag } from "./theme";
export {
  esc, dataAttrs,
  button, badge, label, sectionLabel, divider, spacer, panel, row, col,
  checkbox, switchToggle, radioGroup,
  slider, progressBar, spinner,
  textInput, textArea, numberField,
  segmented, tabs, dropdown, menu,
  listView, scrollView, dataTable, treeView, accordion,
  modal, tooltipWrap, contextMenu, toastStack,
  toolbar, kvTable, fieldError,
} from "./components";
export type {
  ButtonOpts, ToggleOpts, RadioOpts, SliderOpts, InputOpts, NumberFieldOpts,
  SegmentedOpts, TabsOpts, DropdownOpts, MenuItem, ListOpts, TableOpts,
  TreeNode, AccordionSection, Toast, ToastKind,
} from "./components";
export { bindKit } from "./behaviors";
export type { KitDelegate, KitBinding } from "./behaviors";
