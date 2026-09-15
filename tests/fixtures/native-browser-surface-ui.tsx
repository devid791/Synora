import React from "react";
import { createRoot } from "react-dom/client";
import { NativeBrowserSurface, type NativeBrowserViewport } from "../../src/renderer/NativeBrowserSurface";
const state = { id: "tab-a", blocked: false, layouts: [] as (NativeBrowserViewport | null)[] };
const onViewport = (value: NativeBrowserViewport | null) => state.layouts.push(value);
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<NativeBrowserSurface id={state.id} blocked={state.blocked}
  label="Live browser page" onViewport={onViewport} />);
Object.assign(window, {nativeSurfaceFixture: {state, render, unmount: () => root.unmount()}});
render();
