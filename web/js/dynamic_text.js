import { app } from "../../../scripts/app.js";
import {
  hasChoices,
  resolveDynamicPrompt,
  tokenize,
} from "./dynamic_prompt.js";

const NODE_CLASS = "SuperUIDynamicText";
const WIDGET_TYPE = "SUPERUI_DYNAMIC_TEXT";
const ENABLED_SETTING = "SuperUI.DynamicText.Enabled";
const GROUPS_SETTING = "SuperUI.DynamicText.HighlightGroups";
const MIN_HEIGHT = 64;

// One entry per {} nesting level, outermost first; deeper levels cycle back to
// the start. Add, remove or reorder entries freely. `color` tints that level's
// braces and pipes, and `shade` is how strongly it tints the level's
// background when group highlighting is on.
const GROUP_PALETTE = [
  { color: "var(--primary-background, #31b9f4)", shade: 20 }, // blue
  { color: "var(--success-background, #00cd72)", shade: 18 }, // green
  { color: "#c084fc", shade: 22 }, // purple
];

const groupLevel = (depth) => ((depth - 1) % GROUP_PALETTE.length) + 1;

const GROUP_STYLE = GROUP_PALETTE.map(
  ({ color, shade }, i) => `
.superui-dt-syntax.superui-dt-level-${i + 1} { color: ${color}; }
.superui-dt-group-${i + 1} { background: color-mix(in srgb, ${color} ${shade}%, transparent); }`,
).join("");

// The textarea and the highlight layer under it share every text-layout rule
// below, so they line up character for character. Backgrounds use each node
// style's own widget token: the stock textarea classes resolve to the same
// color as the node body in the dark theme.
const STYLE = `
.superui-dt {
  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
}
/* The classic canvas sizes DOM widgets from getMinHeight instead; a CSS
   minimum there overflows onto the widgets below. */
.superui-dt[data-mode="vue"] {
  min-height: ${MIN_HEIGHT}px;
}
.superui-dt[data-mode="classic"] {
  background: var(--comfy-input-bg, #222);
  color: var(--input-text, #ddd);
}
.superui-dt[data-mode="vue"] {
  background: var(--component-node-widget-background, #313235);
  color: var(--base-foreground, #fff);
  border-radius: var(--radius-lg, 0.5rem);
}
/* Stock draws two 1px rings here, and the textarea's own --border-default ring
   paints over the wrapper's lighter one, so that is the color that shows. */
.superui-dt[data-mode="vue"]:focus-within {
  box-shadow: 0 0 0 1px var(--border-default, #494a50);
}
.superui-dt > textarea,
.superui-dt > .superui-dt-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  border: none;
  border-radius: inherit;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
  font-family: monospace;
  font-size: var(--comfy-textarea-font-size, 10px);
  font-weight: normal;
  line-height: 1.4;
  letter-spacing: normal;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  scrollbar-gutter: stable;
}
.superui-dt[data-mode="classic"] > textarea,
.superui-dt[data-mode="classic"] > .superui-dt-backdrop {
  padding: 2px;
}
.superui-dt[data-mode="vue"] > textarea,
.superui-dt[data-mode="vue"] > .superui-dt-backdrop {
  padding: 8px 12px;
}
.superui-dt > textarea {
  resize: none;
  outline: none;
  overflow: hidden auto;
}
.superui-dt > .superui-dt-backdrop {
  overflow: hidden;
  pointer-events: none;
}
.superui-dt[data-highlight="off"] > .superui-dt-backdrop {
  display: none;
}
.superui-dt[data-highlight="on"] > textarea {
  color: transparent;
  caret-color: var(--base-foreground, var(--input-text, #ddd));
}
.superui-dt[data-highlight="on"] > textarea::selection {
  color: transparent;
  background: color-mix(in srgb, var(--primary-background, #31b9f4) 35%, transparent);
}
.superui-dt-comment { color: var(--success-background, #00cd72); }
.superui-dt-syntax { font-weight: bold; }
.superui-dt-escape { color: var(--muted-foreground, #8a8a8a); }
.superui-dt-warning {
  color: var(--warning-foreground, #fd9903);
  font-weight: bold;
  background: color-mix(in srgb, var(--warning-background, #fcbf64) 30%, transparent);
}
${GROUP_STYLE}
`;

function getSetting(id) {
  try {
    return app.extensionManager?.setting?.get(id) ?? app.ui.settings.getSettingValue(id);
  } catch {
    return undefined;
  }
}

const isEnabled = () => getSetting(ENABLED_SETTING) !== false;

// Every live widget controller, so a settings change can refresh them all.
const controllers = new Set();

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightHtml(text, groups) {
  let html = "";
  for (const { start, end, kind, depth } of tokenize(text)) {
    const classes = [];
    if (kind) classes.push(`superui-dt-${kind}`);
    if (depth > 0) {
      // Braces and pipes take their own group's color, bold and unshaded, so
      // group edges stay crisp; everything else in the group gets the shade.
      if (kind === "syntax") classes.push(`superui-dt-level-${groupLevel(depth)}`);
      else if (groups && kind !== "warning") classes.push(`superui-dt-group-${groupLevel(depth)}`);
    }
    const chunk = escapeHtml(text.slice(start, end));
    html += classes.length ? `<span class="${classes.join(" ")}">${chunk}</span>` : chunk;
  }
  // The trailing space keeps a final empty line the same height as the
  // textarea's.
  return html + " ";
}

function createDynamicTextWidget(node, inputName, inputData) {
  const spec = inputData?.[1] ?? {};

  const wrapper = document.createElement("div");
  wrapper.className = "superui-dt";
  const backdrop = document.createElement("div");
  backdrop.className = "superui-dt-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  const textarea = document.createElement("textarea");
  textarea.value = spec.default ?? "";
  textarea.placeholder = inputName;
  textarea.spellcheck = getSetting("Comfy.TextareaWidget.Spellcheck") ?? false;
  // Lets Nodes 2.0 scroll the textarea instead of zooming the canvas.
  textarea.dataset.captureWheel = "true";
  wrapper.append(backdrop, textarea);

  let lastParent;
  const controller = {
    node,
    onTextChanged: () => {},
    restyle() {
      if (!wrapper.isConnected) return;
      // Nodes 2.0 renders each node as an .lg-node element; the classic canvas
      // puts DOM widgets in a floating overlay instead.
      wrapper.dataset.mode = wrapper.closest(".lg-node") ? "vue" : "classic";
    },
    // Cheap enough to call every frame: only restyles once the element has
    // been moved to a new container, which is what switching node style does.
    checkMoved() {
      const parent = wrapper.parentElement;
      if (parent === lastParent) return;
      lastParent = parent;
      controller.restyle();
    },
    render() {
      const on = isEnabled();
      wrapper.dataset.highlight = on ? "on" : "off";
      if (on) {
        backdrop.innerHTML = highlightHtml(textarea.value, getSetting(GROUPS_SETTING) !== false);
        backdrop.scrollTop = textarea.scrollTop;
        backdrop.scrollLeft = textarea.scrollLeft;
      }
      controller.onTextChanged();
    },
  };

  const widget = node.addDOMWidget(inputName, WIDGET_TYPE, wrapper, {
    getValue: () => textarea.value,
    setValue: (value) => {
      textarea.value = value ?? "";
      controller.render();
    },
    socketless: true,
    getMinHeight: () => MIN_HEIGHT,
    // The side panel draws widgets it has no Vue component for onto a canvas,
    // which leaves a DOM widget as an empty row, so leave it out of the panel.
    // A stock-textarea mirror would only refresh on reselect: the panel reads
    // live values from a widget store extensions can't reach.
    surfaces: { canvas: "shown", vueNode: "shown", panel: "never" },
  });
  widget.options.minNodeSize = [400, 200];
  // Nodes 2.0 writes its measured row width into widget.width and never
  // clears it, and the classic overlay sizes DOM widgets from
  // widget.width ?? node.width, so after switching back the box kept the Vue
  // width. Pinning it to undefined makes the box follow the node, as the stock
  // textarea's does.
  //
  // The classic overlay also reads this every frame, which makes it the one
  // reliable signal that we were handed back to the canvas: at minimum size
  // the move doesn't resize anything, so the ResizeObserver stays quiet.
  Object.defineProperty(widget, "width", {
    configurable: true,
    get: () => {
      controller.checkMoved();
      return undefined;
    },
    set: () => {},
  });

  textarea.addEventListener("input", () => {
    controller.checkMoved();
    widget.callback?.(textarea.value);
    controller.render();
  });
  textarea.addEventListener("focus", () => controller.checkMoved());
  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  });

  // Fires when the element is mounted, resized, or moved between the classic
  // canvas and Nodes 2.0, which is when the mode can change.
  const resizeObserver = new ResizeObserver(() => controller.restyle());
  resizeObserver.observe(wrapper);

  // Only the queued prompt gets the resolved text; the workflow keeps what was
  // typed.
  widget.serializeValue = async (graphNode) => {
    if (!isEnabled()) return textarea.value;
    const seed = (graphNode ?? node).widgets?.find((w) => w.name === "seed")?.value;
    return resolveDynamicPrompt(textarea.value, seed);
  };

  const onRemove = widget.onRemove;
  widget.onRemove = function (...args) {
    resizeObserver.disconnect();
    controllers.delete(controller);
    return onRemove?.apply(this, args);
  };

  controllers.add(controller);
  controller.render();
  return { widget, minWidth: 400, minHeight: 200 };
}

// Shows the seed only while the text has a real choice, and stops its
// control_after_generate from stepping otherwise, so an unchanged prompt does
// not invalidate everything downstream on each run.
function setupSeedToggle(node) {
  const textWidget = node.widgets?.find((w) => w.type === WIDGET_TYPE);
  const seed = node.widgets?.find((w) => w.name === "seed");
  if (!textWidget || !seed) return;
  const control =
    seed.linkedWidgets?.[0] ??
    node.widgets.find((w) => w.name === "control_after_generate");
  const controlWasHidden = !!control?.hidden;

  const seedMatters = () => isEnabled() && hasChoices(textWidget.value ?? "");

  for (const hook of ["beforeQueued", "afterQueued"]) {
    const original = control?.[hook];
    if (typeof original !== "function") continue;
    control[hook] = function (...args) {
      if (!seedMatters()) return;
      return original.apply(this, args);
    };
  }

  let shown;
  const update = () => {
    const show = seedMatters();
    if (show === shown) return;
    shown = show;
    seed.hidden = !show;
    if (control) control.hidden = show ? controlWasHidden : true;
    // Grow to fit the seed again; never shrink what the user sized.
    const min = node.computeSize?.();
    if (min) node.setSize([Math.max(node.size[0], min[0]), Math.max(node.size[1], min[1])]);
    node.setDirtyCanvas?.(true, true);
  };

  for (const controller of controllers) {
    if (controller.node === node) controller.onTextChanged = update;
  }
  update();
}

const renderAll = () => {
  for (const controller of controllers) controller.render();
};

app.registerExtension({
  name: "SuperUI.DynamicText",
  settings: [
    {
      id: ENABLED_SETTING,
      category: ["SuperUI", "Dynamic Text", "Enabled"],
      name: "Dynamic Text",
      tooltip: "Comments and {a|b} choices in 🐧 Dynamic Text Entry. When off, text is sent as typed and nothing is highlighted.",
      type: "boolean",
      defaultValue: true,
      onChange: renderAll,
    },
    {
      id: GROUPS_SETTING,
      category: ["SuperUI", "Dynamic Text", "HighlightGroups"],
      name: "Highlight dynamic prompt groups",
      tooltip: "Shades each {} nesting level in its own color.",
      type: "boolean",
      defaultValue: true,
      onChange: renderAll,
    },
  ],
  init() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
  },
  getCustomWidgets() {
    return { [WIDGET_TYPE]: createDynamicTextWidget };
  },
  nodeCreated(node) {
    if ((node.comfyClass ?? node.constructor?.comfyClass) === NODE_CLASS) {
      setupSeedToggle(node);
    }
  },
});
