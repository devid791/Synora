import { z } from "zod";
import type { BrowserFrame, BrowserInput } from "./contracts";

const controlKeys = ["Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Control+a", "Meta+a"] as const;
// The model sees the same required fields and allowed values as validation.
// A flat object with only type required led real Core/Qwen to omit click.button.
const coordinate = { type: "number", minimum: 0 };
const delta = { type: "integer", minimum: -2000, maximum: 2000 };
export const controlInputJsonSchema = {
  anyOf: [
    { type: "object", properties: { type: {const:"click"}, x: coordinate, y: coordinate, button: {type:"string",enum:["left","right","middle"]} }, required:["type","x","y","button"], additionalProperties:false },
    { type: "object", properties: { type: {const:"text"}, text: {type:"string",minLength:1,maxLength:4000} }, required:["type","text"], additionalProperties:false },
    { type: "object", properties: { type: {const:"key"}, key: {type:"string",enum:controlKeys} }, required:["type","key"], additionalProperties:false },
    { type: "object", properties: { type: {const:"scroll"}, x: coordinate, y: coordinate, deltaX: delta, deltaY: delta }, required:["type","x","y","deltaX","deltaY"], additionalProperties:false },
  ],
};

export const controlGrantSchema = z
  .object({
    conversationId: z.string().min(1).max(160),
    browser: z.boolean(),
    computer: z.boolean(),
  })
  .strict();
export type ControlGrant = z.infer<typeof controlGrantSchema>;
export const controlInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
      button: z.enum(["left", "right", "middle"]),
    })
    .strict(),
  z
    .object({ type: z.literal("text"), text: z.string().min(1).max(4000) })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.enum(controlKeys),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
      deltaX: z.number().int().min(-2000).max(2000),
      deltaY: z.number().int().min(-2000).max(2000),
    })
    .strict(),
]);
export type ControlWindow = { id: string; title: string; app: string };
export type NativeInspection = {
  available: boolean;
  reason?: string;
  elements: {
    role: string; name: string; focused: boolean; disabled: boolean;
    value?: string; value_redacted?: boolean;
    click: { x: number; y: number };
    bounds: { left: number; top: number; width: number; height: number };
  }[];
};
export interface ComputerAdapter {
  status(): Promise<{ supported: boolean; reason?: string }>;
  windows(signal: AbortSignal): Promise<ControlWindow[]>;
  capture(id: string, signal: AbortSignal): Promise<BrowserFrame>;
  inspect?(id: string, frame: BrowserFrame, signal: AbortSignal): Promise<NativeInspection>;
  input(
    id: string,
    input: BrowserInput,
    frame: BrowserFrame,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface BrowserAutomation {
  inspect(
    id: string,
  ): Promise<{ url: string; title: string; text: string; elements: unknown[] }>;
  frame(id: string): Promise<BrowserFrame>;
  input(id: string, input: BrowserInput): Promise<void>;
}
export type ControlOwner = {
  conversationId: string;
  threadId: string;
  turnId: string;
  permission: "ask" | "auto-review" | "full";
  mode: "default" | "plan";
};
export interface ControlState {
  grant: ControlGrant | null;
  available: { browser: boolean; computer: boolean; reason?: string };
  pending: {
    id: string;
    title: string;
    details: string;
    conversationId: string;
  } | null;
  activity: {
    id: string;
    tool: string;
    target: string;
    status: "running" | "completed" | "failed";
    at: number;
    error?: string;
    conversationId: string;
  }[];
  preview: {
    kind: "browser" | "computer";
    id: string;
    title: string;
    url?: string;
    frame?: BrowserFrame;
    at: number;
  } | null;
}
