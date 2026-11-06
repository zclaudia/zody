import type {
  GenUiReference,
  GenUiTweakAnnotation,
  GenUiWidgetState,
  GenUiTweakMessage,
} from "./contract.js";
import { buildGenUiExperimentalCapability, projectGenUiContextEntries } from "./contract.js";
export const exampleGenUiReference: GenUiReference = {
  path: "/workspace/charts/sales.html",
  title: "Sales",
};
export const exampleGenUiState: GenUiWidgetState = {
  modelContent: { month: 6 },
  privateContent: { tab: "chart" },
};
export const exampleGenUiTweakRegistration: GenUiTweakMessage = {
  type: "register",
  registrationId: "tweak-1",
  targets: [
    {
      id: "1",
      label: "Player",
      selector: "#player",
      tagName: "div",
      rect: { x: 0, y: 0, width: 200, height: 100 },
    },
  ],
  annotationControls: {
    controlsMode: "replace",
    controls: [
      {
        type: "range",
        callback: "tweak-1-1",
        label: "Radius",
        currentValue: 12,
        min: 0,
        max: 40,
        step: 1,
      },
    ],
  },
};

/** 过渡期宿主能力双宣告：`zody/gen-ui` 与 legacy `zcode/gen-ui`。 */
export const exampleGenUiExperimentalCapability = buildGenUiExperimentalCapability();
/** hostContext 初值双表示：两套键引用同一份状态/微调投影。 */
export const exampleGenUiTweakAnnotation: GenUiTweakAnnotation = {
  active: true,
  selection: null,
  changes: [],
};
export const exampleGenUiContextEntries = projectGenUiContextEntries(
  exampleGenUiState,
  exampleGenUiTweakAnnotation,
);
